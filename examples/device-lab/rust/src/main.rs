use std::sync::Arc;
use serde::{Serialize, Deserialize};
use serde_json::{json, Value};
use futures_util::{StreamExt, SinkExt};
use hypen_server::{app::HypenApp, discovery::ComponentRegistry, remote::RemoteSession};
use hypen_server::device::{Admission, DeviceServer, DeviceServerConfig, DeviceTransport, SessionTransport, UpgradeRequest, StreamItem};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::{Message, handshake::server::{Request, Response, ErrorResponse}};
use sha2::{Sha256, Digest};

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Lab { server: String, runs: u64, result: String, detail: String, history: String }
fn finish(s: &mut Lab, action: &str, ok: bool, detail: String) {
    s.result = format!("{action}: {}", if ok {"OK"} else {"error"});
    s.detail = detail;
    s.history = format!("{}\n{}", s.result, s.history).lines().take(5).collect::<Vec<_>>().join("\n");
    println!("DEVICE_LAB {} {}", s.result, s.detail);
}
enum Out { Text(String), Binary(Vec<u8>), Close(u16, String) }
struct Transport(mpsc::UnboundedSender<Out>);
impl DeviceTransport for Transport {
    fn send_text(&self, s:String) { let _=self.0.send(Out::Text(s)); }
    fn send_binary(&self, b:Vec<u8>) { let _=self.0.send(Out::Binary(b)); }
    fn close(&self, code:u16, reason:&str) { let _=self.0.send(Out::Close(code,reason.into())); }
}
impl SessionTransport for Transport { fn send_ui(&self,s:String) { self.send_text(s); } }
#[tokio::main]
async fn main() {
    let ui=std::fs::read_to_string("../app.hypen").unwrap();
    let server=DeviceServer::new(DeviceServerConfig::default().allow_origin("http://127.0.0.1:45100")
        .authenticate(|r| r.path.split('?').nth(1).unwrap_or("").split('&').any(|p|p=="token=device-lab")));
    let mut builder=HypenApp::module::<Lab>("App").state(Lab { server:"Rust".into(), runs:0,
        result:"Connected. Choose a check.".into(), detail:String::new(), history:String::new() }).ui(&ui);
    for name in ["status","query","permission","gallery","file","save","camera","record","scan","bluetooth","cancel","ping"] {
        builder=builder.on_action::<Value>(name, move |s,_,ctx| {
            s.runs+=1; s.result=format!("{name}: running…");s.detail.clear();
            let d=ctx.expect("remote handler").device();
            if name=="ping" {finish(s,name,true,"UI remains responsive".into());return}
            if name=="cancel" {finish(s,name,true,"Use the host Cancel or Stop control".into());return}
            if name=="status" {
                let caps=["gallery.pick","file.pick","file.save","camera.capture","mic.record","bluetooth.scan","bluetooth.select","permission.query","permission.request"];
                finish(s,name,true,caps.iter().map(|n|format!("{n}: {}",d.supports(n))).collect::<Vec<_>>().join("\n"));return
            }
            if name=="save" {
                match d.save("device-lab-Rust.txt","text/plain","Device Lab payload 0123456789\n".repeat(3400).into_bytes()) {
                    Ok(call)=>{call.then(move |s:&mut Lab,r| match r {
                        Ok(v)=>finish(s,name,true,format!("bytesWritten={} simulated={}",v.bytes_written,v.simulated)),
                        Err(e)=>finish(s,name,false,e.to_string())});},
                    Err(e)=>finish(s,name,false,e.to_string())
                }return
            }
            if name=="record" || name=="scan" {
                let (cap,params)=if name=="record" {("mic.record",json!({"format":"pcm16","sampleRate":16000,"channels":1,"maxDurationMs":3000}))} else {("bluetooth.scan",json!({}))};
                match d.stream(cap,params) {
                    Ok(stream)=>{let mut n=0;let mut hash=Sha256::new();let handle=stream.for_each(move |s:&mut Lab,item| match item {
                        StreamItem::Data{bytes,..}=>{n+=bytes.len();hash.update(&bytes);s.detail=format!("Audio received: {n} bytes");},
                        StreamItem::Event(v)=>{s.detail=v.to_string();},
                        StreamItem::End(r)=>{let ok=r.is_ok();finish(s,name,ok,format!("{r:?} bytes={n} sha256={:x}",hash.clone().finalize()));}
                    });if name=="scan" {std::thread::spawn(move||{std::thread::sleep(std::time::Duration::from_secs(3));handle.cancel();});}},
                    Err(e)=>finish(s,name,false,e.to_string())
                }return
            }
            let (cap,params)=match name {
                "query"=>("permission.query",json!({"permission":"camera"})),
                "permission"=>("permission.request",json!({"permission":"microphone"})),
                "gallery"=>("gallery.pick",json!({"mediaTypes":["photo"],"maxCount":1})),
                "file"=>("file.pick",json!({"accept":["text/plain",".txt"],"maxCount":2})),
                "camera"=>("camera.capture",json!({"mode":"photo","facing":"back"})),
                _=>("bluetooth.select",json!({}))
            };
            match d.request(cap,params) {
                Ok(call)=>{call.then(move |s:&mut Lab,r|match r {
                    Ok(v)=>{let mut detail=v.result.to_string();for b in &v.blobs {
                        let hash=format!("{:x}",Sha256::digest(&b.bytes));
                        std::fs::write(format!("../results-2026-09-26/uploads/{hash}.bin"),&b.bytes).unwrap();
                        detail+=&format!(" verified {} bytes SHA256={hash}",b.bytes.len());
                    }finish(s,name,true,detail);},
                    Err(e)=>finish(s,name,false,e.to_string())
                });},
                Err(e)=>finish(s,name,false,e.to_string())
            }
        });
    }
    let definition=Arc::new(builder.build());
    let listener=tokio::net::TcpListener::bind("127.0.0.1:45105").await.unwrap();
    println!("Device Lab Rust 45105");
    loop {
        let (tcp,_)=listener.accept().await.unwrap();let ds=server.clone();let def=definition.clone();
        tokio::spawn(async move {
            let admit=ds.clone();
            let callback=move |r:&Request,response:Response| -> Result<Response,ErrorResponse> {
                let mut up=UpgradeRequest::new(r.uri().to_string());
                for(k,v)in r.headers(){up=up.with_header(k.as_str(),v.to_str().unwrap_or(""));}
                match admit.admit(&up) {Admission::Admitted=>Ok(response),Admission::Rejected{status,..}=>{
                    let mut e=ErrorResponse::new(Some("forbidden".into()));*e.status_mut()=status.try_into().unwrap();Err(e)}}
            };
            let Ok(ws)=tokio_tungstenite::accept_hdr_async(tcp,callback).await else{return};
            let (mut sink,mut source)=ws.split();let (tx,mut rx)=mpsc::unbounded_channel();
            let session=RemoteSession::connect(def,ComponentRegistry::new(),Arc::new(Transport(tx.clone()))).with_device_server(&ds);
            let writer=tokio::spawn(async move {while let Some(out)=rx.recv().await {
                let m=match out {Out::Text(s)=>Message::Text(s),Out::Binary(b)=>Message::Binary(b),Out::Close(code,reason)=>Message::Close(Some(tokio_tungstenite::tungstenite::protocol::CloseFrame{code:code.into(),reason:reason.into()}))};
                if sink.send(m).await.is_err(){break}
            }});
            while let Some(Ok(m))=source.next().await {match m {
                Message::Text(t)=>session.handle_message_with(&t,|s|{let _=tx.send(Out::Text(s.into()));}),
                Message::Binary(b)=>session.handle_binary(&b),Message::Close(_)=>break,_=>{}
            }}session.handle_close();drop(tx);writer.abort();
        });
    }
}
