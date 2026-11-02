/* ============================================================
   P2P Transfer – Ortak WebRTC Modülü
   Bilgisayarda kamera YOK varsayımıyla:
   - Web (index.html):  offer üretir → QR gösterir → cevap kodunu yapıştırır
   - Mobil (mobile.html): QR okur → cevap kodu üretir → kopyalar
   ============================================================ */

const P2P = (() => {
  const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ];
  const CHUNK_SIZE = 16 * 1024;
  const MAX_BUFFERED = 8 * 1024 * 1024;

  let pc = null;
  let dc = null;
  let pendingCandidates = [];
  let incomingFile = null;
  let hooks = {};

  /* ---------- DataChannel kurulumu ---------- */
  function setupChannel(channel) {
    channel.binaryType = 'arraybuffer';

    channel.onopen = () => hooks.onOpen && hooks.onOpen();
    channel.onclose = () => hooks.onClose && hooks.onClose();
    channel.onerror = (e) => hooks.onError && hooks.onError(e);
    channel.onmessage = (e) => handleIncoming(e.data);
  }

  /* ---------- Gelen veri ---------- */
  function handleIncoming(data) {
    if (typeof data === 'string') {
      let obj;
      try { obj = JSON.parse(data); } catch { return; }
      if (obj.k === 'text') {
        hooks.onText && hooks.onText(obj.v);
      } else if (obj.k === 'file-meta') {
        incomingFile = { name: obj.name, type: obj.type, size: obj.size, chunks: [], received: 0 };
        hooks.onProgress && hooks.onProgress(`Alınıyor: ${obj.name}`, 0);
      } else if (obj.k === 'file-end') {
        finishIncoming();
      }
      return;
    }
    if (data instanceof ArrayBuffer && incomingFile) {
      incomingFile.chunks.push(data);
      incomingFile.received += data.byteLength;
      const pct = Math.min(100, Math.round((incomingFile.received / incomingFile.size) * 100));
      hooks.onProgress && hooks.onProgress(`Alınıyor: ${incomingFile.name}`, pct);
      if (pct >= 100) finishIncoming();
    }
  }

  function finishIncoming() {
    if (!incomingFile) return;
    const blob = new Blob(incomingFile.chunks, { type: incomingFile.type || 'application/octet-stream' });
    hooks.onFile && hooks.onFile(blob, incomingFile.name, incomingFile.type, false);
    hooks.onProgressHide && hooks.onProgressHide();
    incomingFile = null;
  }

  /* ---------- Web tarafı: offer üret → QR için hazır ---------- */
  async function createOffer(h) {
    hooks = h || {};
    pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    dc = pc.createDataChannel('data', { ordered: true });
    setupChannel(dc);

    pendingCandidates = [];
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        pendingCandidates.push(e.candidate.toJSON());
      } else {
        // ICE toplama bitti → offer + adayları QR için ver
        hooks.onOfferReady && hooks.onOfferReady(JSON.stringify({
          t: 'offer',
          sdp: pc.localDescription.sdp,
          cand: pendingCandidates
        }));
      }
    };

    pc.onconnectionstatechange = () => {
      hooks.onConnState && hooks.onConnState(pc.connectionState);
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
  }

  /* ---------- Web tarafı: cevap kodunu uygula ---------- */
  async function applyAnswer(raw) {
    let payload;
    try { payload = JSON.parse(raw); } catch { throw new Error('Kod JSON değil'); }
    if (payload.t !== 'answer') throw new Error('Bu bir answer kodu değil');
    await pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp });
    for (const c of payload.cand || []) {
      try { await pc.addIceCandidate(c); } catch {}
    }
  }

  /* ---------- Mobil tarafı: offer'dan answer üret ---------- */
  async function acceptOfferAndAnswer(raw, h) {
    hooks = h || {};
    let payload;
    try { payload = JSON.parse(raw); } catch { throw new Error('QR verisi JSON değil'); }
    if (payload.t !== 'offer') throw new Error('Bu bir offer değil');

    pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pendingCandidates = [];

    pc.ondatachannel = (e) => {
      dc = e.channel;
      setupChannel(dc);
    };
    pc.onicecandidate = (e) => {
      if (e.candidate) pendingCandidates.push(e.candidate.toJSON());
    };
    pc.onconnectionstatechange = () => {
      hooks.onConnState && hooks.onConnState(pc.connectionState);
    };

    await pc.setRemoteDescription({ type: 'offer', sdp: payload.sdp });
    for (const c of payload.cand || []) {
      try { await pc.addIceCandidate(c); } catch {}
    }
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    // ICE toplama tamamlanana kadar bekle (max 3 sn)
    await new Promise(res => {
      if (pc.iceGatheringState === 'complete') return res();
      const check = () => {
        if (pc.iceGatheringState === 'complete') {
          pc.removeEventListener('icegatheringstatechange', check);
          res();
        }
      };
      pc.addEventListener('icegatheringstatechange', check);
      setTimeout(res, 3000);
    });

    return JSON.stringify({
      t: 'answer',
      sdp: pc.localDescription.sdp,
      cand: pendingCandidates
    });
  }

  /* ---------- Metin gönder ---------- */
  function sendText(v) {
    if (!v || !dc || dc.readyState !== 'open') return false;
    dc.send(JSON.stringify({ k: 'text', v }));
    return true;
  }

  /* ---------- Dosya gönder (chunking + backpressure) ---------- */
  async function sendFile(file) {
    if (!dc || dc.readyState !== 'open') return;
    dc.send(JSON.stringify({
      k: 'file-meta',
      name: file.name,
      type: file.type,
      size: file.size
    }));

    const reader = file.stream().getReader();
    let sent = 0;
    hooks.onProgress && hooks.onProgress(`Gönderiliyor: ${file.name}`, 0);

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (let off = 0; off < value.length; off += CHUNK_SIZE) {
          const chunk = value.slice(off, off + CHUNK_SIZE);
          while (dc.bufferedAmount > MAX_BUFFERED) {
            await new Promise(r => setTimeout(r, 30));
          }
          dc.send(chunk);
          sent += chunk.byteLength;
          const pct = Math.min(100, Math.round((sent / file.size) * 100));
          hooks.onProgress && hooks.onProgress(`Gönderiliyor: ${file.name}`, pct);
        }
      }
      dc.send(JSON.stringify({ k: 'file-end' }));
      hooks.onProgressHide && hooks.onProgressHide();
      hooks.onFile && hooks.onFile(file, file.name, file.type, true);
    } catch (err) {
      hooks.onProgressHide && hooks.onProgressHide();
      hooks.onError && hooks.onError(err);
    }
  }

  /* ---------- Durum ---------- */
  function isOpen() {
    return !!(dc && dc.readyState === 'open');
  }

  return {
    createOffer,
    applyAnswer,
    acceptOfferAndAnswer,
    sendText,
    sendFile,
    isOpen
  };
})();
