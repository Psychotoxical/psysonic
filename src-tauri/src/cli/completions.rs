// Bundled at compile time for `psysonic completions bash|zsh` (no extra files in packages).
const COMPLETIONS_BASH: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../completions/psysonic.bash"
));
const COMPLETIONS_ZSH: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../completions/_psysonic"
));

/// `psysonic completions …` — returns exit code when this argv should not start the GUI.
pub fn try_completions_dispatch(args: &[String]) -> Option<i32> {
    if args.get(1).map(|s| s.as_str()) != Some("completions") {
        return None;
    }
    let program = args.first().map(|s| s.as_str()).unwrap_or("psysonic");
    match args.get(2).map(|s| s.as_str()) {
        None | Some("help") | Some("--help") | Some("-h") => {
            print_completions_install_help(program);
            Some(0)
        }
        Some("bash") => {
            print!("{COMPLETIONS_BASH}");
            Some(0)
        }
        Some("zsh") => {
            print!("{COMPLETIONS_ZSH}");
            Some(0)
        }
        Some(x) => {
            eprintln!("NOT OK: unknown completions subcommand {x:?} (expected: bash, zsh, help)");
            Some(2)
        }
    }
}

fn print_completions_install_help(program: &str) {
    eprintln!(
        "Psysonic embeds bash/zsh completion scripts in this binary.\n\
         \n\
         Bash — try once in this shell:\n\
           eval \"$({program} completions bash)\"\n\
         Or install:\n\
           mkdir -p ~/.local/share/psysonic\n\
           {program} completions bash > ~/.local/share/psysonic/psysonic.bash\n\
           echo '. ~/.local/share/psysonic/psysonic.bash' >> ~/.bashrc && source ~/.bashrc\n\
         \n\
         Zsh — install file then register (once in ~/.zshrc before compinit):\n\
           mkdir -p ~/.zsh/completions\n\
           {program} completions zsh > ~/.zsh/completions/_psysonic\n\
           fpath=(~/.zsh/completions $fpath)\n\
           autoload -Uz compinit && compinit\n\
         \n\
         Scripts only (stdout, for piping):\n\
           {program} completions bash\n\
           {program} completions zsh\n",
        program = program,
    );
}
