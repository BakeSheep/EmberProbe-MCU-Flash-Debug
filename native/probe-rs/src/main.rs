mod catalog;
mod clock;
mod engine;
mod identity;
mod memory;
mod protocol;
use serde_json::json;
use std::{io, sync::mpsc, thread};

fn main() {
    if std::env::args().nth(1).as_deref() == Some("--version") {
        println!("emberprobe-probe-rs 0.1.0 protocol=1 probe-rs=0.32.0");
        return;
    }
    if std::env::args().nth(1).as_deref() == Some("--list-chips") {
        match catalog::list(&std::env::args().skip(2).collect::<Vec<_>>()) {
            Ok(chips) => println!("{chips}"),
            Err(error) => {
                eprintln!("{error:#}");
                std::process::exit(1);
            }
        }
        return;
    }
    let (input_tx, input_rx) = mpsc::sync_channel(32);
    thread::spawn(move || {
        let mut input = io::stdin().lock();
        loop {
            match protocol::read_request(&mut input) {
                Ok(Some(request)) => {
                    if input_tx.send(Ok(request)).is_err() {
                        break;
                    }
                }
                Ok(None) => break,
                Err(error) => {
                    let _ = input_tx.send(Err(error));
                    break;
                }
            }
        }
    });
    let (output_tx, output_rx) = mpsc::sync_channel::<Vec<u8>>(16);
    let writer = thread::spawn(move || {
        let mut output = io::stdout().lock();
        for bytes in output_rx {
            if protocol::write_frame(&mut output, &bytes).is_err() {
                break;
            }
        }
    });
    let result = engine::run(input_rx, output_tx.clone());
    if let Err(error) = &result {
        let _ = output_tx.send(protocol::control(&json!({"event": "failure", "error": {
            "code": "PROBE_RS_CONNECTION_FAILED", "message": format!("{error:#}")}})));
    }
    drop(output_tx);
    let _ = writer.join();
    if result.is_err() {
        std::process::exit(1);
    }
}
