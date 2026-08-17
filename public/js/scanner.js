/**
 * Strekkodeskanning med nettleserens innebygde BarcodeDetector.
 *
 * Støtte i praksis: Chrome på Android har det. Safari på iPhone har det ikke.
 * Vi legger derfor ikke inn noe skannerbibliotek — appen tilbyr i stedet et
 * felt der du skriver inn tallene under strekkoden. Det virker overalt, og
 * biblioteket kan legges til senere hvis iPhone-støtte blir viktig.
 *
 * Kamera krever HTTPS (eller localhost). Netlify gir HTTPS, så det går bra.
 */

const FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e"];

export function scannerSupported() {
  return typeof window !== "undefined" && "BarcodeDetector" in window && !!navigator.mediaDevices?.getUserMedia;
}

/**
 * Starter skanning inn i et <video>-element.
 * Returnerer en stopp-funksjon som må kalles når du er ferdig, ellers står
 * kameraet på.
 */
export async function startScan({ video, onResult, onError }) {
  if (!scannerSupported()) {
    throw new Error("Denne nettleseren har ikke innebygd strekkodeleser.");
  }

  let stopped = false;
  let stream = null;
  let timer = null;

  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    for (const track of stream?.getTracks() ?? []) track.stop();
    if (video) video.srcObject = null;
  };

  try {
    // Bakkameraet, ikke selfie-kameraet.
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } },
      audio: false,
    });
  } catch {
    throw new Error("Fikk ikke tilgang til kameraet. Sjekk at du har gitt tillatelse.");
  }

  video.srcObject = stream;
  video.setAttribute("playsinline", "");
  video.muted = true;
  await video.play().catch(() => {});

  const detector = new window.BarcodeDetector({ formats: FORMATS });

  const tick = async () => {
    if (stopped) return;
    try {
      const found = await detector.detect(video);
      const code = found.find((f) => /^\d{6,14}$/.test(f.rawValue ?? ""));
      if (code) {
        onResult(code.rawValue);
        return; // kalleren bestemmer om vi skal skanne videre
      }
    } catch (err) {
      onError?.(err);
    }
    // ~4 forsøk i sekundet er nok, og sparer batteri.
    timer = setTimeout(tick, 250);
  };

  tick();
  return stop;
}
