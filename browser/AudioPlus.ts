export class AudioPlus {
  /** 是否为伴奏 */
  private isInstrumental = false;
  private readonly gainNode: GainNode;
  private readonly source: MediaElementAudioSourceNode;
  private readonly splitter: ChannelSplitterNode;
  constructor(
    private readonly audio: HTMLAudioElement,
    public readonly audioContext: AudioContext = new AudioContext()
  ) {
    // 将 <audio> 变成 AudioNode
    this.source = audioContext.createMediaElementSource(audio); // 分离两个声道
    this.splitter = audioContext.createChannelSplitter(2);
    this.gainNode = audioContext.createGain();
    const invertLeft = this.audioContext.createGain();
    this.splitter.connect(invertLeft, 0);
    invertLeft.gain.value = -1;
    invertLeft.connect(this.gainNode, 0);
    this.splitter.connect(this.gainNode, 1); // 输出
    this.gainNode.connect(audioContext.destination); // this.volume = 1;
    // this.instrumental = false;
    this.source.connect(this.gainNode);
  }
  public set volume(value: number) {
    this.gainNode.gain.value = value;
  }
  public get volume() {
    return this.gainNode.gain.value;
  }
  public set instrumental(value: boolean) {
    if (this.isInstrumental === value) return;
    this.isInstrumental = value;
    if (value) {
      this.source.connect(this.splitter);
      this.source.disconnect(this.gainNode);
    } else {
      this.source.connect(this.gainNode);
      this.source.disconnect(this.splitter);
    }
  }
  /** 是否为伴奏 */
  public get instrumental() {
    return this.isInstrumental;
  }

  public micInfo: {
    stream: MediaStream;
    node: ChannelMergerNode;
    gain: GainNode;
  } | null = null;
  public get mic() {
    return Boolean(this.micInfo);
  }

  public async setMic(value: boolean) {
    if (this.mic === value) return;
    const disconnectMic = () => {
      if (!this.micInfo) return;
      const { stream, node, gain } = this.micInfo;
      if (stream.active) stream.getTracks().forEach(track => track.stop());
      if (gain) gain.disconnect();
      if (node) node.disconnect();
      this.micInfo = null;
    };
    disconnectMic();
    if (!value) return;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: 48000,
        sampleSize: 16,
        autoGainControl: false,
        noiseSuppression: false,
        echoCancellation: false,
      },
    });
    const source = this.audioContext.createMediaStreamSource(stream);

    const splitter = this.audioContext.createChannelSplitter(2);
    const merger = this.audioContext.createChannelMerger(2);
    const gain = this.audioContext.createGain();
    gain.gain.value = 1;

    source.connect(splitter);
    // 第 0 个麦克风声道 → 输出左右两个声道
    splitter.connect(merger, 0, 0);
    splitter.connect(merger, 0, 1);

    merger.connect(gain);

    gain.connect(this.audioContext.destination);

    disconnectMic();
    this.micInfo = { stream, node: merger, gain };
  }
}
