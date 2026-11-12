package main

import (
 "crypto/sha256"
 "encoding/hex"
 "io"
 "net/http"
 "net/http/httptest"
 "strings"
 "sync/atomic"
 "testing"
)

func hostingConfig(a,b string) Config {
 hash:=sha256.Sum256([]byte(testToken))
 return Config{
  Version:1,
  Keys:[]Key{{ID:"consumer",Digest:hex.EncodeToString(hash[:]),Enabled:true,Mode:"all"}},
  Models:[]Model{
   {ID:"model-a",Actual:"shared-model",PublicName:"shared-model",KeepOriginal:true,Enabled:true,
    ExposureIDs:map[string]string{"shared-model":"grant-a"},UpstreamID:"source-a"},
   {ID:"model-b",Actual:"shared-model",PublicName:"shared-model",KeepOriginal:true,Enabled:true,
    ExposureIDs:map[string]string{"shared-model":"grant-b"},UpstreamID:"source-b"},
  },
  Upstreams:[]Upstream{{ID:"source-a",URL:a,KeyEnv:"SB_TEST_A",Auth:"bearer"},
                       {ID:"source-b",URL:b,KeyEnv:"SB_TEST_B",Auth:"bearer"}},
 }
}
func TestHostingSameModelPriorityAndFailover(t *testing.T){
 t.Setenv("SB_TEST_A","private-a");t.Setenv("SB_TEST_B","private-b")
 var first,second atomic.Int32
 a:=httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){
  first.Add(1)
  if r.Header.Get("Authorization")!="Bearer private-a"{t.Error("source A key mismatch")}
  w.WriteHeader(429);io.WriteString(w,"rate limited")
 }))
 defer a.Close()
 b:=httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){
  second.Add(1)
  if r.Header.Get("Authorization")!="Bearer private-b"{t.Error("source B key mismatch")}
  w.Header().Set("Content-Type","application/json")
  io.WriteString(w,`{"model":"shared-model","choices":[{"message":{"content":"ok"}}]}`)
 }))
 defer b.Close()
 c:=hostingConfig(a.URL,b.URL)
 snapshot,err:=compile(c);if err!=nil{t.Fatal(err)}
 ledger,err:=openLedger(t.TempDir());if err!=nil{t.Fatal(err)};defer ledger.Close()
 g:=newGateway(snapshot,ledger);defer g.transport.CloseIdleConnections()
 server:=httptest.NewServer(g);defer server.Close()
 code,body:=call(t,server,"/v1/chat/completions",`{"model":"shared-model","messages":[{"role":"user","content":"hello"}]}`)
 if code!=200||!strings.Contains(string(body),"ok"){t.Fatalf("failover: %d %s",code,body)}
 if first.Load()!=1||second.Load()!=1{t.Fatalf("expected A then B, got %d and %d",first.Load(),second.Load())}
 _,catalog:=call(t,server,"/v1/models","")
 if strings.Count(string(catalog),`"id":"shared-model"`)!=1{t.Fatalf("shared id repeated: %s",catalog)}
 // Reordered sources should use B first, without contacting A.
 c.Version++;c.Models[0],c.Models[1]=c.Models[1],c.Models[0]
 next,err:=compile(c);if err!=nil{t.Fatal(err)}
 if err:=g.apply(next);err!=nil{t.Fatal("apply failed:",err)}
 code,_=call(t,server,"/v1/chat/completions",`{"model":"shared-model","messages":[{"role":"user","content":"hello"}]}`)
 if code!=200||first.Load()!=1||second.Load()!=2{t.Fatalf("source priority failed: status=%d first=%d second=%d routes=%v",code,first.Load(),second.Load(),next.routes["shared-model"])}
}
func TestHostingGroupPermissionAndDisabledSource(t *testing.T){
 t.Setenv("SB_TEST_A","private-a");t.Setenv("SB_TEST_B","private-b")
 upstream:=httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){
  w.Header().Set("Content-Type","application/json")
  io.WriteString(w,`{"model":"shared-model","choices":[]}`)
 }));defer upstream.Close()
 c:=hostingConfig(upstream.URL,upstream.URL)
 c.Keys[0].Mode="selected";c.Keys[0].Allowed=[]string{"grant-b"}
 first,err:=compile(c);if err!=nil{t.Fatal(err)}
 chosen,code:=first.resolve(&first.cfg.Keys[0],"shared-model")
 if code!=0||chosen.UpstreamID!="source-a"{t.Fatal("group permission must authorize ordered group")}
 c.Models[0].Enabled=false
 second,err:=compile(c);if err!=nil{t.Fatal(err)}
 chosen,code=second.resolve(&second.cfg.Keys[0],"shared-model")
 if code!=0||chosen.UpstreamID!="source-b"{t.Fatal("disabled source should be skipped")}
}
