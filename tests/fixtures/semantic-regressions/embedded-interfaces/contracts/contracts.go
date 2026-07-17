package contracts

type Reader interface { Read() error }
type Closer interface { Close() error }
type ReadCloser interface { Reader; Closer }

type Service struct{}
func (Service) Read() error { return nil }
func (Service) Close() error { return nil }
