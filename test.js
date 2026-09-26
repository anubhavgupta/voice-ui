import { writeFile } from "node:fs/promises";

const response = await fetch("http://127.0.0.1:8091/v1/audio/speech", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    input: "Hello, this is a direct text to speech test.",
    stream: false,
    response_format: "wav",
  }),
});

console.log(
  response.status,
  response.headers.get("content-type"),
  response.headers.get("content-length")
);

const audio = Buffer.from(await response.arrayBuffer());
await writeFile("tts_wav_test.wav", audio);