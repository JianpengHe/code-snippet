import * as http from "http";
import * as child_process from "child_process";

http.get("http://www.baidu.com/", res => {
  const date = new Date(res.headers.date || "");
  child_process.exec(`echo ${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} | date`, () => {
    child_process.exec(`echo ${date.getHours()}:${date.getMinutes()}:${date.getSeconds()} | time`, () => {
      child_process.exec("w32tm /resync", () => {});
    });
  });
});
