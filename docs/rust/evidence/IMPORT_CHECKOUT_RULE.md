# Import checkout rule

The source import job must operate on a clean exact-head checkout with persisted credentials disabled. It may commit only after bundle verification and all source gates succeed; failure leaves the branch unchanged.
