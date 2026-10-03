use super::*;

#[test]
fn actual_composed_parser_control_is_shared_across_phases_sticky_and_fresh_retry_is_independent() {
    use crate::native_latex_theorem_syntax::parse_new_theorem_declarations_with_control_v1;
    let cancelled = AtomicBool::new(false);
    let deadline = Instant::now() + std::time::Duration::from_secs(30);
    let mut context = NativeResearchReadContextV1::new(&cancelled, deadline);
    let first = context.syntax_control_v1().unwrap();
    let second = context.syntax_control_v1().unwrap();
    assert!(std::rc::Rc::ptr_eq(&first, &second));
    let source = "\\newtheorem{theorem}{Theorem}\n".repeat(256);
    let mut refusal = None;
    for phase in 0..128 {
        let control = if phase % 2 == 0 { &first } else { &second };
        if let Err(error) = parse_new_theorem_declarations_with_control_v1(&source, control) {
            refusal = Some(error);
            break;
        }
    }
    assert_eq!(
        refusal.as_deref(),
        Some("native_latex_theorem_syntax_match_budget_exceeded")
    );
    assert!(context.require_active().is_err());
    assert!(context.syntax_control_v1().is_err());
    let mut fresh = NativeResearchReadContextV1::new(&cancelled, deadline);
    let fresh_control = fresh.syntax_control_v1().unwrap();
    assert!(!std::rc::Rc::ptr_eq(&first, &fresh_control));
    let observed = parse_new_theorem_declarations_with_control_v1(
        "\\newtheorem{theorem}{Theorem}\n",
        &fresh_control,
    )
    .unwrap();
    assert_eq!(observed.declarations.len(), 1);
    fresh.require_active().unwrap();
    cancelled.store(true, Ordering::SeqCst);
    assert!(fresh.require_active().is_err());
    cancelled.store(false, Ordering::SeqCst);
    assert!(fresh.require_active().is_err());
    let mut expired = NativeResearchReadContextV1::new(&cancelled, Instant::now());
    assert!(expired.syntax_control_v1().is_err());
}
