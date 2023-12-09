navigator.mediaDevices
  .getUserMedia({
    audio: {
      sampleRate: 48000,
      channelCount: 1,
      autoGainControl: false,
      noiseSuppression: false,
      echoCancellation: false,
    },
  })
  .then(stream => {
    const chunks: Blob[] = [];
    const now = new Date().getTime();
    const mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm; codecs=pcm" });
    mediaRecorder.ondataavailable = ({ data }) => chunks.push(data);
    mediaRecorder.start();
    mediaRecorder.onstop = () => {
      const audioURL = window.URL.createObjectURL(new Blob(chunks, { type: "audio/webm; codecs=pcm" }));
      const a = document.createElement("a");
      a.href = audioURL;
      a.download = now + ".webm";
      document.body.append(a);
      a.click();
    };
  });
