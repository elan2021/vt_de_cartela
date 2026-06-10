const text = "Atencao, clientes do Supermercado! Picanha por apenas cinquenta e quatro reais e noventa centavos! Nao perca!";
console.log("Testing", text.length, "chars");
const start = Date.now();
try {
  const res = await fetch("http://localhost:3460/tts-generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, voice_name: "Marcos" }),
    signal: AbortSignal.timeout(300000),
  });
  console.log("Status:", res.status);
  console.log("Duration:", res.headers.get("X-Audio-Duration"));
  const buf = Buffer.from(await res.arrayBuffer());
  console.log("Bytes:", buf.length);
  console.log("Time:", ((Date.now() - start) / 1000).toFixed(1) + "s");
} catch(e) {
  console.error("Error:", e.message);
}
