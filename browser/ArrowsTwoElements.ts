type IElement = {
  div: HTMLDivElement;
  a: HTMLAnchorElement;
  pre: HTMLPreElement;
  span: HTMLSpanElement;
  button: HTMLButtonElement;
  label: HTMLLabelElement;
  input: HTMLInputElement;
  form: HTMLFormElement;
};
const copyObj = (obj, target) => {
  for (const k in obj) {
    if (typeof obj[k] === "object") {
      target[k] = target[k] || {};
      copyObj(obj[k], target[k]);
      continue;
    }
    target[k] = obj[k];
  }
};
function NewElement<TagName extends keyof IElement>(
  tagName: TagName,
  opt?: Partial<IElement[TagName] | { style: Partial<CSSStyleDeclaration> }>
): IElement[TagName] {
  const dom: IElement[TagName] = document.createElement(tagName);
  copyObj(opt, dom);
  return dom;
}

class ArrowsTwoElements {
  public from: HTMLElement;
  public to: HTMLElement;
  public readonly dom: HTMLDivElement;
  public color: string;
  constructor(from: HTMLElement, to: HTMLElement, color = "red") {
    this.from = from;
    this.to = to;
    this.dom = document.createElement("div");
    this.color = color;
    this.dom.style.position = "absolute";
    this.dom.style.zIndex = "-9999";
    this.dom.style.top = "0";
    this.dom.style.left = "0";
    this.render();
  }
  private getElementCenter(dom: HTMLElement) {
    return { x: dom.offsetWidth / 2 + dom.offsetLeft, y: dom.offsetHeight / 2 + dom.offsetTop };
  }
  public render() {
    const from = this.getElementCenter(this.from);
    const to = this.getElementCenter(this.to);
    const startX = Math.min(from.x, to.x) - 5;
    const startY = Math.min(from.y, to.y) - 5;
    const id = "triangle" + Math.random();

    this.dom.innerHTML = `<svg width="${Math.abs(from.x - to.x) + 10}px" height="${
      Math.abs(from.y - to.y) + 10
    }px" style="position: absolute;top:${startY}px;left:${startX}px">
    <path d="M ${from.x - startX},${from.y - startY} L ${to.x - startX},${to.y - startY}" style="stroke: ${
      this.color
    }; stroke-width: 2px; stroke-dasharray: 0%; marker-end: url(#${id});"></path>
    <defs>
      <marker id="${id}" markerWidth="10" markerHeight="10" markerUnits="strokeWidth" refX="4" refY="2" orient="auto">
        <path d="M 0 0 L 5 2 L 0 4 z" fill="${this.color}" />
      </marker>
    </defs>
  </svg>`;
  }
}

class RequestNode {
  public dom: HTMLDivElement;
  public reqData: Map<string, HTMLElement> = new Map();
  public resData: Map<string, HTMLElement> = new Map();
  constructor({
    method,
    url,
    reqHeaders,
    reqBody,
    resHeaders,
    resBody,
  }: {
    method: string;
    url: URL;
    reqHeaders: { [x: string]: string };
    reqBody: any;
    resHeaders: { [x: string]: string };
    resBody: any;
  }) {
    this.dom = NewElement("div", {
      style: { border: "1px solid", width: "fit-content", display: "none", margin: "5px" },
    });
    this.dom.appendChild(
      NewElement("div", {
        className: "url",
        innerHTML: `${method.toUpperCase()} ${url.protocol}//${url.host}${
          url.pathname
        }<button>追踪</button><button>展开</button><button>删除</button>`,
      })
    );
    if (url.searchParams.size) {
      this.dom.appendChild(NewElement("div", { className: "title", innerHTML: `query` }));
      this.dom.appendChild(
        this.renderObj(
          [...url.searchParams.entries()].reduce((obj, [k, v]) => ({ ...obj, [k]: v }), {}),
          "mark-req"
        )
      );
    }

    if (reqBody) {
      this.dom.appendChild(NewElement("div", { className: "title", innerHTML: `reqBody` }));
      this.dom.appendChild(this.renderObj(reqBody, "mark-req"));
    }
    if (resBody) {
      this.dom.appendChild(NewElement("div", { className: "title", innerHTML: `resBody` }));
      this.dom.appendChild(this.renderObj(resBody, "mark-res"));
    }

    for (const dom of this.dom.getElementsByClassName("mark-req")) {
      //@ts-ignore
      this.reqData.set(String(dom.innerHTML).trim(), dom);
    }
    for (const dom of this.dom.getElementsByClassName("mark-res")) {
      //@ts-ignore
      this.resData.set(String(dom.innerHTML).trim(), dom);
    }
  }
  private renderObj(obj: any, className: string) {
    const div = NewElement("div", {
      innerHTML: `<pre>${JSON.stringify(obj, null, 2)
        .split("\n")
        .map(
          line =>
            "<p>" +
            line
              .replace(/</g, "&lt;")
              .replace(/:\s*"([\d\D]{4,}?)",{0,1}$/, (r, a) =>
                r.replace(a, `<span class="${className}">` + a + "</span>")
              ) +
            "</p>"
        )
        .join("")}</pre>`,
    });

    return div;
  }
}
function ch({
  localReq: { method, url, headers: reqHeaders, body: reqBody },
  remoteRes: { headers: resHeaders, body: resBody },
}) {
  reqBody = String(reqBody).trim();
  resBody = String(resBody).trim();
  return new RequestNode({
    method,
    url: new URL(url),
    reqHeaders,
    reqBody: reqBody ? JSON.parse(reqBody) : "",
    resHeaders,
    resBody: resBody ? JSON.parse(resBody) : "",
  });
}

function go(ignore?: Set<number>) {
  const reqsDom = document.getElementById("reqs");
  const arrowsDom = document.getElementById("arrows");
  if (!reqsDom || !arrowsDom) return;
  reqsDom.innerHTML = "";
  arrowsDom.innerHTML = "";
  function renderAll() {
    new Promise<void>(r => r()).then(() => arrowsTwoElementsList.forEach(a => a.render()));
  }

  const list: RequestNode[] = [];
  const arrowsTwoElementsList: ArrowsTwoElements[] = [];
  const colorMap: Map<string, string> = new Map();
  //@ts-ignore
  [...reqs].forEach((req, i) => {
    if (ignore?.has(i)) return;
    const requestNode = ch(req);
    for (const old of list) {
      for (const [str, dom] of requestNode.reqData) {
        const oldDom = old.resData.get(str);
        if (oldDom) {
          requestNode.dom.style.display = "";
          old.dom.style.display = "";
          //@ts-ignore
          oldDom.parentElement.className = "active";
          //@ts-ignore
          dom.parentElement.className = "active";
          const color = colorMap.get(str) || "#" + Math.random().toString(16).substr(-6);
          colorMap.set(str, color);
          const arrowsTwoElements = new ArrowsTwoElements(oldDom, dom, color);
          arrowsDom.appendChild(arrowsTwoElements.dom);
          arrowsTwoElementsList.push(arrowsTwoElements);
          // new ArrowsTwoElements(oldDom, dom);
          requestNode.reqData.delete(str);
        }
      }
    }
    list.push(requestNode);
    requestNode.dom.id = "reqs" + i;
    reqsDom.appendChild(requestNode.dom);
  });
  if (!ignore) {
    ignore = new Set();
    for (const { dom } of list) {
      if (dom.style.display === "none") {
        ignore.add(Number((dom.id || "").substring(4)));
      }
    }
    go(ignore);
    return;
  }
  renderAll();
  document.body.onclick = (e: any) => {
    const { target } = e;
    if (target.nodeName === "BUTTON") {
      const dom = target.parentElement.parentElement;
      const index = Number((dom.id || "").substring(4));
      if (isNaN(index)) return;

      switch (String(target.innerHTML).trim()) {
        case "追踪":
          for (const d of list) {
            const i = Number((d.dom.id || "").substring(4));
            if (d.dom !== dom && !d.dom.querySelector(".active .mark-res") && !isNaN(i)) {
              ignore?.add(i);
            }
          }
          go(ignore);
          return;
        case "删除":
          ignore?.add(index);
          go(ignore);
          return;
        case "展开":
          dom.className = "zk";
          target.innerHTML = "收起";
          break;
        case "收起":
          dom.className = "";
          target.innerHTML = "展开";
          break;
      }

      renderAll();
    }
  };
  window.onresize = renderAll;
}

go();
