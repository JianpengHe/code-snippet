"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ToBat = void 0;
class ToBat {
    onFiles;
    constructor(onFiles) {
        if (!onFiles)
            throw new Error("必须传入onFile回调函数");
        this.onFiles = onFiles;
    }
    apply(compiler) {
        const pluginName = ToBat.name;
        const { webpack } = compiler;
        const { Compilation } = webpack;
        compiler.hooks.thisCompilation.tap(pluginName, compilation => {
            compilation.hooks.processAssets.tap({
                name: pluginName,
                stage: Compilation.PROCESS_ASSETS_STAGE_SUMMARIZE,
            }, assets => {
                const onFiles = {};
                for (const name in assets) {
                    const content = assets[name]?.source?.();
                    if (!content)
                        continue;
                    onFiles[name] = {
                        filename: name,
                        content: content.replace(/[^\x00-\xff]/g, str => escape(str).replace(/\%u/g, "\\u")),
                        raw: assets[name],
                        compilation,
                    };
                }
                this.onFiles(onFiles);
            });
        });
    }
    static headUAC = `/** \n@echo off\n%1 mshta vbscript:createobject("shell.application").shellexecute("%~s0","::","","runas",1)(window.close)&exit\ncd /d %~dp0\ncls\nnode %0\npause\nexit\n**/`;
    static head = `/** \n@echo off\ncls\nnode %0\npause\nexit\n**/`;
}
exports.ToBat = ToBat;
//# sourceMappingURL=ToBat.js.map