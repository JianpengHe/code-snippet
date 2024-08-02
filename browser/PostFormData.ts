export class PostFormData extends FormData {
  public readonly form: HTMLFormElement;
  public readonly fetchInit: RequestInit;
  public action = "/";
  constructor(form: HTMLFormElement, fetchInit?: Omit<RequestInit, "body">) {
    super(form);
    this.form = form;
    fetchInit = { ...fetchInit };
    fetchInit.headers = {
      "content-type": form.enctype || "application/x-www-form-urlencoded; charset=UTF-8",
      ...fetchInit.headers,
    };

    this.fetchInit = { method: form.method || "post", ...fetchInit };
    this.action = form.action || "/";
  }
  public get body() {
    return this.fetchInit.headers?.["content-type"].includes("x-www-form-urlencoded")
      ? String(new URLSearchParams(this as any))
      : this;
  }
  public send() {
    return fetch(this.action, { body: this.body, ...this.fetchInit });
  }
  public toObject() {
    // @ts-ignore
    return Object.fromEntries(this.entries());
  }
  public toJSON() {
    return this.toObject();
  }
}

/** 测试用例 */
// const parser = new DOMParser().parseFromString(await(await fetch("/merge/edit")).text(), "text/html");
// var postFormData = new PostFormData(parser.getElementsByTagName("form")[0]);
// // postFormData.fetchInit.method = "post";
// // postFormData.set("content", String(Math.random()));
// postFormData.send();
