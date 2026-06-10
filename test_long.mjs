const longText = "Atencao, clientes do Supermercado Bom Preco! Oferta imperdivel: Picanha por apenas cinquenta e quatro reais e noventa centavos! Temos tambem Alcatra por trinta e sete reais e noventa e oito centavos! Flash que e por tempo limitado! Nao perca esta oportunidade!";

console.log("Text length:", longText.length, "chars");
console.log("Calling /tts-generate...");
const start = Date.now();

try {
  const res = await fetch("http://localhost:3460/tts-generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: longText, voice_name: "Marcos" }),
    signal: AbortSignal.timeout(310000),
  });
  console.log("Status:", res.status);
  console.log("Duration:", res.headers.get("X-Audio-Duration"));
  const buf = Buffer.from(await res.arrayBuffer());
  console.log("Bytes:", buf.length);
  console.log("Time:", ((Date.now() - start) / 1000).toFixed(1) + "s");
} catch(e) {
  console.error("Error:", e.message);
}
