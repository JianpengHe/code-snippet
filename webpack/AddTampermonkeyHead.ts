import * as fs from "fs";

export class AddTampermonkeyHead {
  public onFile: (content: string, inputFilePath: string, outputFilename: string) => string;
  // 需要传入自定义插件构造函数的任意选项
  //（这是自定义插件的公开API）
  constructor(onFile: AddTampermonkeyHead["onFile"]) {
    this.onFile = onFile;
  }

  apply(compiler) {
    const pluginName = AddTampermonkeyHead.name;

    // webpack 模块实例，可以通过 compiler 对象访问，
    // 这样确保使用的是模块的正确版本
    // （不要直接 require/import webpack）
    const { webpack } = compiler;

    // Compilation 对象提供了对一些有用常量的访问。
    const { Compilation } = webpack;
    // RawSource 是其中一种 “源码”("sources") 类型，
    // 用来在 compilation 中表示资源的源码
    const { RawSource } = webpack.sources;
    // 绑定到 “thisCompilation” 钩子，
    // 以便进一步绑定到 compilation 过程更早期的阶段
    compiler.hooks.thisCompilation.tap(pluginName, compilation => {
      // console.log(compilation);
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
          const {
            output: { filename },
            entry,
          } = compilation.options;

          // console.log(compilation.options.entry, assets, filename);
          const assetsNames = Object.keys(assets);
          for (const proj in entry) {
            for (const inputFilePath of entry[proj].import) {
              const outputFilename = this.getOutputFilename(filename, assetsNames, proj);
              const content = assets[outputFilename]?.source();
              if (!content) continue;
              const header = this.onFile(content, inputFilePath, outputFilename);
              if (header) {
                assets[outputFilename] = new RawSource(header + "\n" + content);
              }
            }
          }
        }
      );
    });
  }
  static parseFile(
    filePath: string,
    package_json = {},
    /** 是否写入版本等package.json里面的信息，方便脚本读取 */
    isWriteUsedPackageJson = false
  ) {
    const data = String(fs.readFileSync(filePath)).split("\n");
    const start = data.findIndex(str => str.replace(/\s/g, "").toLowerCase() === "//==userscript==");
    if (start < 0) throw new Error("入口文件" + filePath + "没找到“// ==UserScript==”头");
    const end = data.slice(start + 1).findIndex(str => str.replace(/\s/g, "").toLowerCase() === "//==/userscript==");
    if (end < 0) throw new Error("入口文件" + filePath + "没找到“// ==/UserScript==”结尾");
    const writeUsedPackageJson = {};
    return (
      data
        .slice(start, end + 1 + start + 1)
        .join("\n")
        .replace(
          /\{\{package_json\.(.+?)\}\}/g,
          (_, keyName) => (writeUsedPackageJson[keyName] = package_json[keyName] || "")
        ) +
      "\n" +
      (isWriteUsedPackageJson ? `const package_json=${JSON.stringify(writeUsedPackageJson)};` : "")
    );
  }
  public getOutputFilename(rule: string, assetsNames: string[], projName: string) {
    return rule.replace(/\[name\]/g, projName);
  }
}

// 使用例子
// plugins: [
//   new AddTampermonkeyHead((content, inputFilePath, outputFilename) => AddTampermonkeyHead.parseFile(inputFilePath)),
// ]

// 使用例子2
// plugins: [
//   new AddTampermonkeyHead((content, inputFilePath, outputFilename) =>
//     AddTampermonkeyHead.parseFile(inputFilePath, JSON.parse(String(fs.readFileSync(__dirname + "/package.json"))), true)
//   ),
// ]
