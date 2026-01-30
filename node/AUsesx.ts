import * as path from "path";
export class AUsesx {
  public readonly list: {
    filePath: string;
    startSample: number;
    totalSample: number;
    endSample: number;
    name: string;
    fileID: number;
  }[] = [];
  constructor(
    public readonly audioChannelType: string = "mono",
    public readonly bitDepth: number = 16,
    public readonly sampleRate: number = 48000
  ) {}
  public add(filePath: string, startSample: number, totalSample: number, name: string) {
    if (!path.isAbsolute(filePath)) filePath = path.resolve(__dirname, filePath);
    this.list.push({
      filePath,
      startSample,
      totalSample,
      endSample: startSample + totalSample,
      name,
      fileID: this.list.length,
    });
  }
  public toString() {
    const list = [...this.list].sort((a, b) => a.startSample - b.startSample);
    const tracks: AUsesx["list"][] = [];
    for (const item of list) {
      let track =
        tracks.length === 0
          ? null
          : tracks.reduce((prev, cur) => {
              if (prev[prev.length - 1].endSample <= cur[cur.length - 1].endSample) return prev;
              return cur;
            });
      if (!track || item.startSample - track[track.length - 1].endSample < 60 * this.sampleRate)
        tracks.push((track = []));
      track.push(item);
    }

    return `<?xml version="1.0" encoding="UTF-8" standalone="no" ?>
<!DOCTYPE sesx>
<sesx version="1.9">
  <session appBuild="24.0.0.46" appVersion="24.0" audioChannelType="${this.audioChannelType}" bitDepth="${
      this.bitDepth
    }" sampleRate="${this.sampleRate}">
    <tracks>
${tracks
  .map(
    (track, index) => `<audioTrack id="${index + 10001}" index="${index + 1}">
        <trackParameters trackHeight="134">
          <name>轨道 ${index + 1}</name>
        </trackParameters>
        <trackAudioParameters audioChannelType="${this.audioChannelType}">
          <trackOutput outputID="10000" type="trackID"/>
        </trackAudioParameters>
${track
  .map(
    (item, index) =>
      `        <audioClip id="${index}" fileID="${item.fileID}" name="${item.name}" sourceOutPoint="${item.totalSample}" startPoint="${item.startSample}" zOrder="${index}"></audioClip>`
  )
  .join("\n")}
      </audioTrack>`
  )
  .join("\n")}      
    </tracks>
  </session>
  <files>
${list.map(item => `<file absolutePath="${item.filePath}" id="${item.fileID}" mediaHandler="AmioWav" />`).join("\n")}
  </files>
</sesx>
`;
  }
}
