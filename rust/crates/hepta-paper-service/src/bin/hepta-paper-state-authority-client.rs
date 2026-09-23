use hepta_paper_service::local_state_authority_client::{
    LocalStateAuthorityClientOptionsV1, format_local_state_authority_client_json_output_v1,
    run_local_state_authority_client_json_v1,
};

fn main() {
    let argv = std::env::args_os()
        .skip(1)
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    let result = run_local_state_authority_client_json_v1(
        &argv,
        std::io::stdin().lock(),
        &LocalStateAuthorityClientOptionsV1::default(),
    )
    .and_then(|receipt| format_local_state_authority_client_json_output_v1(&receipt));
    match result {
        Ok(output) => print!("{output}"),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
