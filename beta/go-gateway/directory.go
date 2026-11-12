package main

import (
  "context"
  "encoding/json"
  "strings"
)

// The public directory is derived from the permission-checked model graph,
// not from a random upstream. Hosted-only models must remain discoverable
// even when the optional local CLI proxy is unavailable.
func (g *gateway) modelDirectory(_ context.Context, s *snapshot, k *Key, path string) ([]byte, int, error) {
  seen := map[string]bool{}
  rows := []any{}
  google := strings.HasPrefix(path, "/v1beta/")
  for _, e := range s.ordered {
    id := normalized(e.Name)
    if seen[id] { continue }
    if _, code := s.resolve(k, e.Name); code != 0 { continue }
    seen[id] = true
    if google {
      rows = append(rows, map[string]any{"name":"models/"+e.Name, "displayName":e.Name})
    } else {
      rows = append(rows, map[string]any{"id":e.Name, "object":"model", "owned_by":"scrollbridge"})
    }
  }
  if google { data,err:=json.Marshal(map[string]any{"models":rows});return data,200,err }
  data,err:=json.Marshal(map[string]any{"object":"list", "data":rows})
  return data,200,err
}
