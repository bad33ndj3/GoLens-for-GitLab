package service

type Box[T any] struct{}
func (Box[T]) Get() T { var zero T; return zero }

type IntBox = Box[int]
func Use(value IntBox) int { return value.Get() }
