theorem conclusionFromPremise (P : Prop) (h : P) : P := h

theorem genuineIdentity (P : Prop) : P → P := fun h => h

theorem vacuousTrue : True := True.intro
