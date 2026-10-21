package main

import (
	"context"
	"errors"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

const redisConfigKey = "scrollbridge:beta:{gateway}:config"
const redisChannel = "scrollbridge:beta:config-changed"

type redisState struct{ client *redis.Client }

func newRedis(raw string) (*redisState, error) {
	opts, err := redis.ParseURL(raw)
	if err != nil {
		return nil, errors.New("invalid Redis URL")
	}
	opts.MaxRetries = -1
	opts.DialTimeout = time.Second
	opts.ReadTimeout = time.Second
	opts.WriteTimeout = time.Second
	return &redisState{redis.NewClient(opts)}, nil
}
func (r *redisState) Close() error { return r.client.Close() }
func (r *redisState) publish(ctx context.Context, s *snapshot, b []byte) error {
	const script = `local old=tonumber(redis.call('HGET',KEYS[1],'version') or '0')
 if tonumber(ARGV[1])<=old then return 0 end
 redis.call('HSET',KEYS[1],'version',ARGV[1],'blob',ARGV[2])
 redis.call('PUBLISH',ARGV[3],ARGV[1])
 return 1`
	n, err := r.client.Eval(ctx, script, []string{redisConfigKey}, s.cfg.Version, string(b), redisChannel).Int()
	if err != nil {
		return errors.New("Redis publish unavailable")
	}
	if n != 1 {
		return errors.New("Redis version must increase")
	}
	return nil
}
func (r *redisState) load(ctx context.Context) (*snapshot, error) {
	values, err := r.client.HMGet(ctx, redisConfigKey, "version", "blob").Result()
	if err != nil || len(values) != 2 || values[0] == nil || values[1] == nil {
		return nil, errors.New("Redis configuration unavailable")
	}
	version, ok := values[0].(string)
	blob, ok2 := values[1].(string)
	if !ok || !ok2 {
		return nil, errors.New("invalid Redis configuration")
	}
	s, err := decodeConfig([]byte(blob))
	if err != nil {
		return nil, err
	}
	if strconv.FormatInt(s.cfg.Version, 10) != version {
		return nil, errors.New("Redis version mismatch")
	}
	return s, nil
}
func (r *redisState) Reserve(key string, n, limit int64) error {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	const script = `local used=tonumber(redis.call('GET',KEYS[1]) or '0')
 if used+tonumber(ARGV[1])>tonumber(ARGV[2]) then return 0 end
 redis.call('INCRBY',KEYS[1],ARGV[1]);return 1`
	v, err := r.client.Eval(ctx, script, []string{"scrollbridge:beta:quota:" + key}, n, limit).Int()
	if err != nil || v != 1 {
		return errors.New("quota unavailable or exhausted")
	}
	return nil
}
func (r *redisState) Refund(key string, n int64) error {
	if n == 0 {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	const script = `local used=tonumber(redis.call('GET',KEYS[1]) or '0')
 if tonumber(ARGV[1])<0 or used<tonumber(ARGV[1]) then return 0 end
 redis.call('DECRBY',KEYS[1],ARGV[1]);return 1`
	v, err := r.client.Eval(ctx, script, []string{"scrollbridge:beta:quota:" + key}, n).Int()
	if err != nil || v != 1 {
		return errors.New("quota refund unavailable")
	}
	return nil
}
