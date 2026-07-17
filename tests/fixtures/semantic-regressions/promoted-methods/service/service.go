package service

type Base struct{}
func (*Base) Run() error { return nil }

type EmbeddedPointer struct { *Base }

type Left struct{}
func (Left) Ping() {}
type Right struct{}
func (Right) Ping() {}
type Ambiguous struct { Left; Right }
func Use(value Ambiguous) { value.Ping() }
