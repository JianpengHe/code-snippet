import * as fs from "fs";
import * as path from "path";
export class CopyHTML {
  // 需要传入自定义插件构造函数的任意选项
  //（这是自定义插件的公开API）
  private srcPath: string;
  private distPath: string;
  public entry: { [x: string]: string } = {};
  public output: {
    path: string; // 打包输出文件路径(__dirname指向当前文件的`绝对路径`)
    filename: string; // 打包输出文件的名字, 插入hash值
  };
  constructor(srcPath: string = "./src", distPath: string = "./dist") {
    this.distPath = distPath;
    this.srcPath = srcPath;
    this.output = {
      path: this.distPath,
      filename: "[name].js", // 打包输出文件的名字, 插入hash值
    };
    const files = new Set(fs.readdirSync(this.srcPath));
    for (const file of files) {
      if (/\.ts$/.test(file)) {
        const name = file.substring(0, file.length - 3);
        if (files.has(name + ".html")) {
          this.entry[name] = path.resolve(this.srcPath, file);
        }
      }
    }
  }

  public apply(compiler) {
    const pluginName = CopyHTML.name;

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
          for (const name in this.entry) {
            const content = assets[name + ".js"]?.source();
            // console.log(name);
            if (content) {
              const html = String(fs.readFileSync(path.resolve(this.srcPath, name + ".html"))).replace(
                `<script src="${name}.js"></script>`,
                `<script>${content}</script>`
              );
              fs.writeFile(path.resolve(this.distPath, name + ".html"), html, () => {});
              //  compilation.emitAsset("1.bat", new RawSource(`/** \n@echo off\ncls\nnode %0\npause\nexit\n**/` + content));
            }
          }
        }
      );
    });
  }
}

/** 测试用例 */
// const copyHTML = new CopyHTML(path.resolve(__dirname, "./src/browser"), path.resolve(__dirname, "./dist"));
// const clientConfig = {
//   entry: copyHTML.entry,
//   output: copyHTML.output,
//   plugins: [copyHTML],
// };
