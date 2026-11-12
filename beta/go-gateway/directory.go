package main

import (
 "context"
 "encoding/json"
 "errors"
 "net/http"
 "net/url"
 "strings"
)

// The local proxy remains authoritative for which local models it currently
// advertises. Hosted models are added from the configured model graph.
func (g *gateway) modelDirectory(ctx context.Context, s *snapshot, k *Key, path string) ([]byte,int,error){
 google:=strings.HasPrefix(path,"/v1beta/")
 field:="data";if google{field="models"}
 seen:=map[string]bool{}
 output:=[]any{}
 add:=func(model map[string]any,entry entry){
  if !entry.Available||!entry.Enabled {return}
  if _,code:=s.resolve(k,entry.Name);code!=0{return}
  name:=normalized(entry.Name)
  if seen[name]{return}
  seen[name]=true
  copy:=map[string]any{}
  for key,value:=range model {copy[key]=value}
  if google{
   copy["name"]="models/"+entry.Name
   copy["displayName"]=entry.Name
  }else{
   copy["id"]=entry.Name
   if _,ok:=copy["object"];!ok{copy["object"]="model"}
  }
  output=append(output,copy)
 }
 local:=[]Upstream{}
 for _,up:=range s.cfg.Upstreams{
  if up.Protocol==""||up.Protocol=="local"||up.ID=="local-proxy"{local=append(local,up)}
 }
 hadLocal:=len(local)==0
 if len(local)>0{
  supply,done,ok:=g.pool.pick(local)
  if ok{
   target,parseErr:=url.Parse(supply.URL)
   if parseErr!=nil{done(0,nil,parseErr)}else{
    target.Path=path
    req,err:=http.NewRequestWithContext(ctx,"GET",target.String(),nil)
    if err!=nil{done(0,nil,err)}else{
     req.Header.Set("Accept-Encoding","identity")
     supplyCredentials(req,supply)
     response,err:=g.transport.RoundTrip(req)
     if err!=nil{done(502,nil,err)}else{
      func(){
       defer response.Body.Close()
       defer done(response.StatusCode,response.Header,nil)
       if response.StatusCode>=400{return}
       reader,close,e:=decodeReader(response.Body,response.Header.Get("Content-Encoding"))
       if e!=nil{return}
       defer close()
       raw,free,e:=g.read(reader,4<<20,s.cfg.Limits.MemoryBytes)
       if e!=nil{return}
       defer free()
       v,e:=strictJSON(raw);if e!=nil{return}
       obj,ok:=v.(map[string]any);if !ok{return}
       rows,ok:=obj[field].([]any);if !ok{return}
       hadLocal=true
       for _,item:=range rows{
        model,ok:=item.(map[string]any);if !ok{continue}
        id,_:=model["id"].(string)
        if google{id,_=model["name"].(string)}
        for _,entry:=range s.ordered{
         if entry.UpstreamID!=""&&entry.UpstreamID!="local-proxy"{continue}
         if normalized(entry.Actual)==normalized(id){add(model,entry)}
        }
       }
      }()
     }
    }
   }
  }
 }
 // Hosted IDs are eligible without contacting the local proxy.
 hadHosted:=false
 for _,entry:=range s.ordered{
  if entry.UpstreamID==""||entry.UpstreamID=="local-proxy"{continue}
  hadHosted=true
  model:=map[string]any{"id":entry.Actual,"object":"model","name":"models/"+entry.Actual}
  add(model,entry)
 }
 if !hadLocal&&!hadHosted{return nil,502,errors.New("upstream model directory unavailable")}
 if google{
  out,err:=json.Marshal(map[string]any{"models":output});return out,200,err
 }
 out,err:=json.Marshal(map[string]any{"object":"list","data":output})
 return out,200,err
}
