theorem conclusionFromPremise (P : Prop) (h : P) : P := h

theorem wrappedConclusionFromPremise (P : Prop) (h : P ∧ True) : P := h.1

theorem implicationWrappedConclusionFromPremise (P : Prop) (h : True → P) : P := h True.intro

theorem genuineIdentity (P : Prop) : P → P := fun h => h

theorem vacuousTrue : True := True.intro
