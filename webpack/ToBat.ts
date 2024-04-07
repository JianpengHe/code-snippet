type IOnFiles = { content: string; filename: string; raw: any; compilation: any };
export class ToBat {
  private onFiles: (filesInfo: { [x: string]: IOnFiles }) => void;
  // 需要传入自定义插件构造函数的任意选项
  //（这是自定义插件的公开API）
  constructor(onFiles: ToBat["onFiles"]) {
    if (!onFiles) throw new Error("必须传入onFile回调函数");
    this.onFiles = onFiles;
  }

  public apply(compiler) {
    const pluginName = ToBat.name;

    // webpack 模块实例，可以通过 compiler 对象访问，
    // 这样确保使用的是模块的正确版本
    // （不要直接 require/import webpack）
    const { webpack } = compiler;

    // Compilation 对象提供了对一些有用常量的访问。
    const { Compilation } = webpack;
    // RawSource 是其中一种 “源码”("sources") 类型，
    // 用来在 compilation 中表示资源的源码
    // const { RawSource } = webpack.sources;

    // 绑定到 “thisCompilation” 钩子，
    // 以便进一步绑定到 compilation 过程更早期的阶段
    compiler.hooks.thisCompilation.tap(pluginName, compilation => {
      // 绑定到资源处理流水线(assets processing pipeline)
      compilation.hooks.processAssets.tap(
        {
          name: pluginName,

          // 用某个靠后的资源处理阶段，
          // 确保所有资源已被插件添加到 compilation
          stage: Compilation.PROCESS_ASSETS_STAGE_SUMMARIZE,
        },
        assets => {
          // "assets" 是一个包含 compilation 中所有资源(assets)的对象。
          // 该对象的键是资源的路径，
          // 值是文件的源码
          const onFiles: { [x: string]: IOnFiles } = {};
          for (const name in assets) {
            const content: string = assets[name]?.source?.();
            if (!content) continue;
            onFiles[name] = {
              filename: name,
              content: content.replace(/[^\x00-\xff]/g, str => escape(str).replace(/\%u/g, "\\u")),
              raw: assets[name],
              compilation,
            };
          }
          this.onFiles(onFiles);
        }
      );
    });
  }
  static headUAC = `/** \n@echo off\n%1 mshta vbscript:createobject("shell.application").shellexecute("%~s0","::","","runas",1)(window.close)&exit\ncd /d %~dp0\ncls\nnode %0\npause\nexit\n**/`;
  static head = `/** \n@echo off\ncls\nnode %0\npause\nexit\n**/`;
}

/** 测试用例 */
// const serverConfig = {
//   entry: {
//     index: path.resolve(__dirname, "./src/server/index.ts"),
//     init: path.resolve(__dirname, "./src/server/init.ts"),
//   },
//   target: "node",
//   output: {
//     path: path.resolve(__dirname, "./src/server/"),
//     filename: "[name].js",
//   },
//   plugins: [
//     new ToBat(files => {
//       for (const name in files) {
//         const head = name === "init.js" ? ToBat.headUAC : ToBat.head;
//         const { content } = files[name];
//         fs.writeFile("dist/" + name + ".bat", head + content, () => {});
//       }
//     }),
//   ],
// };
