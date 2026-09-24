// 测试用 stub：只实现插件用到的那几个链式方法，供装配测试在 Node 原生解析下 import。
// 它**只在测试 loader 里被引用**（见 test/loader.mjs），不放进插件目录的 node_modules,
// 以免干扰 DSH 自己的模块解析（宿主从 app 的 node_modules 提供真实实现）。
const make = (type) => {
  const schema = { type, __stubSchema: true }
  schema.default = (value) => {
    schema.defaultValue = value
    return schema
  }
  schema.description = (text) => {
    schema.descriptionText = text
    return schema
  }
  schema.step = () => schema
  schema.min = () => schema
  schema.max = () => schema
  return schema
}

const Schema = {
  object: (shape) => {
    const schema = make('object')
    schema.shape = shape
    return schema
  },
  boolean: () => make('boolean'),
  string: () => make('string'),
  number: () => make('number'),
  array: (inner) => {
    const schema = make('array')
    schema.inner = inner
    return schema
  },
  union: (list) => {
    const schema = make('union')
    schema.list = list
    return schema
  },
}

export default Schema
