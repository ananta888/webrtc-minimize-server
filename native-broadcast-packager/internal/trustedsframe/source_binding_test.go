package trustedsframe

import (
	"reflect"
	"sync/atomic"
	"testing"
	"time"
)

func TestSourceReceiverAliveForChecksEveryImmutableField(t *testing.T) {
	l := sourceLeaseFixture()
	at := time.Now().UnixMilli()
	l.IssuedAt = at
	l.ExpiresAt = at + 2000
	l.Consent.GrantedAt = at - 1000
	l.Consent.ExpiresAt = at + 60000
	var allowed atomic.Bool
	allowed.Store(true)
	r, err := NewSourceReceiver(jsonBytes(t, l), l.Consent.GranteePackagerRef, l.Consent.GranteeDeviceRef, func(SourceLease, int64) bool { return allowed.Load() }, at)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Destroy()
	if !r.AliveFor(l) {
		t.Fatal("valid receiver binding rejected")
	}
	mutate := func(v reflect.Value) {
		switch v.Kind() {
		case reflect.String:
			v.SetString(v.String() + "x")
		case reflect.Int, reflect.Int64:
			v.SetInt(v.Int() + 1)
		default:
			t.Fatal("unhandled scope field")
		}
	}
	for i := 0; i < reflect.TypeOf(l).NumField(); i++ {
		name := reflect.TypeOf(l).Field(i).Name
		if name == "Revision" || name == "IssuedAt" || name == "ExpiresAt" {
			continue
		}
		if name == "Consent" {
			for j := 0; j < reflect.TypeOf(l.Consent).NumField(); j++ {
				bad := l
				mutate(reflect.ValueOf(&bad.Consent).Elem().Field(j))
				if r.AliveFor(bad) {
					t.Fatal("changed consent field accepted", j)
				}
			}
		} else {
			bad := l
			mutate(reflect.ValueOf(&bad).Elem().Field(i))
			if r.AliveFor(bad) {
				t.Fatal("changed binding accepted", name)
			}
		}
	}
	next := l
	next.Revision++
	next.ExpiresAt = at + 3000
	if err := r.RenewNow(jsonBytes(t, next)); err != nil {
		t.Fatal(err)
	}
	if !r.AliveFor(l) || !r.AliveFor(next) {
		t.Fatal("authorized renewal lost immutable binding")
	}
	allowed.Store(false)
	if r.AliveFor(l) {
		t.Fatal("policy loss ignored")
	}
	r.Destroy()
	if r.AliveFor(next) {
		t.Fatal("destroyed binding revived")
	}
}
