package service

type PointerRunner struct{}
func (*PointerRunner) Run() error { return nil }

type ValueRunner struct{}
func (ValueRunner) Run() error { return nil }
