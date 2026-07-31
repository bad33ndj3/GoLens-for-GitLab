# Plan the atomic switch-over and merge-request sequence

Type: `grilling`
Status: open
Blocked by: 02, 04, 05, 06, 07, 08, 09, 11, 12

## Question

What ordered, logically reviewable commit sequence builds the replacement beside the legacy runtime, switches every MV3 entry point atomically, resets storage with clear upgrade communication, removes obsolete files and compatibility layers, and provides a safe rollback point plus final acceptance checklist?
