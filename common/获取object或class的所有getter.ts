const getGetterKeys = variable => {
  if (!variable) {
    return [];
  }
  if (variable.prototype?.constructor === variable) {
    /** class未实例化后的 */
    variable = variable.prototype;
  } else if (variable.constructor !== Object) {
    /** 不是普通object */
    variable = variable.constructor.prototype;
  }

  const getters = Object.getOwnPropertyDescriptors(variable);
  return Object.keys(getters).filter(key => typeof getters[key].get === "function");
};

class A {
  get name() {
    return "aaa";
  }
  _name = "a2";
}

console.log(getGetterKeys(A));
console.log(getGetterKeys(new A()));
console.log(
  getGetterKeys({
    get name() {
      return "aaa";
    },
    _name: "a2",
  })
);
