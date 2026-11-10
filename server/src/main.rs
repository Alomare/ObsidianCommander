use commander::{Config, PROTOCOL, VERSION};
use std::io::Read;
use std::path::PathBuf;

const USAGE: &str = "commander-server --data <dir> --port <port> --token <admin token> [--ui <dir>] [--lan-port <port>] [--keep-running]";

fn main() {
    let mut data = None;
    let mut port = None;
    let mut token = None;
    let mut ui = None;
    let mut lan_port = None;
    let mut keep_running = false;
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--data" => data = args.next().map(PathBuf::from),
            "--port" => port = args.next().and_then(|p| p.parse::<u16>().ok()),
            "--token" => token = args.next(),
            "--ui" => ui = args.next().map(PathBuf::from),
            "--lan-port" => lan_port = args.next().and_then(|p| p.parse::<u16>().ok()),
            "--keep-running" => keep_running = true,
            "--version" => {
                println!("commander-server {VERSION} protocol={PROTOCOL}");
                return;
            }
            _ => fail(&format!("unknown argument `{a}`")),
        }
    }
    let data = data.unwrap_or_else(|| fail("--data is required"));
    let port = port.unwrap_or_else(|| fail("--port is required (0 lets the system choose)"));
    let token = token
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| fail("--token is required"));
    let ui = ui.unwrap_or_else(|| {
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.join("ui")))
            .unwrap_or_else(|| PathBuf::from("ui"))
    });

    let mut cfg = Config::new(data, port, token, ui);
    if let Some(p) = lan_port {
        cfg.lan_port = p;
    }
    let handle = match commander::start(cfg) {
        Ok(h) => h,
        Err(e) => fail(&format!("could not start: {e}")),
    };
    println!(
        "COMMANDER READY port={} version={VERSION} protocol={PROTOCOL}",
        handle.port
    );

    if keep_running {
        loop {
            std::thread::park();
        }
    }
    // Obsidian holds the server stdin; when it goes away, the server exits.
    let mut sink = [0u8; 256];
    let mut stdin = std::io::stdin();
    while matches!(stdin.read(&mut sink), Ok(n) if n > 0) {}
    handle.shutdown();
}

fn fail(msg: &str) -> ! {
    eprintln!("{msg}\nusage: {USAGE}");
    std::process::exit(2);
}
