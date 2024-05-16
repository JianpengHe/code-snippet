import { socks5 } from "../../tools/dist/node/systemNetworkSettings";
import { TcpProxy } from "../../tools/dist/node/TcpProxy";
import { DnsServer } from "../../tools/dist/node/dnsService";

const port = 443;
const tcpProxy = new TcpProxy(new DnsServer());
tcpProxy.add({
  host: "pub.dev",
  port,
  connectionListener: sock =>
    socks5({ host: "pub.dev", port }).then(sock2 => {
      console.log("代理", "pub.dev", port);
      sock.pipe(sock2);
      sock2.pipe(sock);
      sock.on("error", e => console.log(e));
      sock2.on("error", e => console.log(e));
    }),
});
tcpProxy.add({
  host: "maven.google.com",
  port,
  connectionListener: sock =>
    socks5({ host: "maven.google.com", port }).then(sock2 => {
      console.log("代理", "maven.google.com", port);
      sock.pipe(sock2);
      sock2.pipe(sock);
      sock.on("error", e => console.log(e));
      sock2.on("error", e => console.log(e));
    }),
});
tcpProxy.add({
  host: "objects.githubusercontent.com",
  port,
  connectionListener: sock =>
    socks5({ host: "objects.githubusercontent.com", port }).then(sock2 => {
      console.log("代理", "objects.githubusercontent.com", port);
      sock.pipe(sock2);
      sock2.pipe(sock);
      sock.on("error", e => console.log(e));
      sock2.on("error", e => console.log(e));
    }),
});
