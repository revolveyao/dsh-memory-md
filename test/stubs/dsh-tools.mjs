// 测试用 stub：真实实现里 defineTool 是「类型辅助 + 少量运行时包装」，
// 装配测试只需要拿到工具定义对象本身，故这里是 identity。
export const defineTool = (definition) => definition
