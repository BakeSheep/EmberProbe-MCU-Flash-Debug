use anyhow::{Result, ensure};
use serde::Deserialize;
use serde_json::Value;
use std::io::{Read, Write};
pub const MAX_FRAME: usize = 1024 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub id: u32,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}
pub fn read_request(reader: &mut impl Read) -> Result<Option<Request>> {
    let mut header = [0u8; 4];
    if reader.read(&mut header[..1])? == 0 {
        return Ok(None);
    }
    reader.read_exact(&mut header[1..])?;
    let length = u32::from_le_bytes(header) as usize;
    ensure!((2..=MAX_FRAME).contains(&length), "Invalid frame length");
    let mut body = vec![0; length];
    reader.read_exact(&mut body)?;
    ensure!(body[0] == 1, "Unsupported frame type");
    let request: Request = serde_json::from_slice(&body[1..])?;
    ensure!(
        request.id > 0 && request.method.len() <= 32,
        "Invalid request identity"
    );
    Ok(Some(request))
}
pub fn control(value: &Value) -> Vec<u8> {
    let data = serde_json::to_vec(value).expect("JSON response");
    let mut frame = Vec::with_capacity(5 + data.len());
    frame.extend_from_slice(&((data.len() + 1) as u32).to_le_bytes());
    frame.push(1);
    frame.extend_from_slice(&data);
    frame
}
pub struct Batch {
    pub generation: u32,
    pub recipe: u8,
    pub payload_bytes: usize,
    pub count: u16,
    bytes: Vec<u8>,
}
impl Batch {
    pub fn new(generation: u32, recipe: u8, payload_bytes: usize) -> Self {
        Self {
            generation,
            recipe,
            payload_bytes,
            count: 0,
            bytes: Vec::new(),
        }
    }
    pub fn push(&mut self, timestamp: f64, duration_ms: f32, bytes: &[u8]) {
        assert_eq!(bytes.len(), self.payload_bytes);
        self.bytes.extend_from_slice(&timestamp.to_le_bytes());
        self.bytes.extend_from_slice(&duration_ms.to_le_bytes());
        self.bytes.extend_from_slice(bytes);
        self.count += 1;
    }
    pub fn finish(self) -> Vec<u8> {
        let length = 12 + self.bytes.len();
        assert!(length <= MAX_FRAME);
        let mut frame = Vec::with_capacity(4 + length);
        frame.extend_from_slice(&(length as u32).to_le_bytes());
        frame.push(2);
        frame.extend_from_slice(&self.generation.to_le_bytes());
        frame.push(self.recipe);
        frame.extend_from_slice(&self.count.to_le_bytes());
        frame.extend_from_slice(&(self.payload_bytes as u32).to_le_bytes());
        frame.extend_from_slice(&self.bytes);
        frame
    }
}
pub fn write_frame(writer: &mut impl Write, bytes: &[u8]) -> Result<()> {
    ensure!(bytes.len() <= MAX_FRAME + 4, "Output frame budget");
    writer.write_all(bytes)?;
    writer.flush()?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_frames() {
        assert!(read_request(&mut &(u32::MAX.to_le_bytes())[..]).is_err());
        assert!(read_request(&mut &[8, 0, 0, 0, 1][..]).is_err());
        assert!(read_request(&mut &[2, 0, 0, 0, 2, 0][..]).is_err());
        assert!(read_request(&mut &[][..]).unwrap().is_none());
    }
    #[test]
    fn binary_samples() {
        let mut batch = Batch::new(17, 3, 4);
        batch.push(1000.125, 0.5, &[1, 2, 3, 4]);
        let frame = batch.finish();
        assert_eq!(u32::from_le_bytes(frame[..4].try_into().unwrap()), 28);
        assert_eq!(frame[9], 3);
        assert_eq!(
            f64::from_le_bytes(frame[16..24].try_into().unwrap()),
            1000.125
        );
        assert_eq!(&frame[28..], &[1, 2, 3, 4]);
    }
}
