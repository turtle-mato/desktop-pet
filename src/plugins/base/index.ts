import type { PetPlugin } from "../../core/pluginManager";

export default {
  manifest: { id: "base", name: "基础陪伴", order: 0, description: "核心陪伴基础，向上下文提供基本信息" },
  init(ctx) {
    ctx.chat.addContext(() => "陪伴模式：基础互动、记忆、待办、番茄钟、久坐提醒与主动搭话均已开启。");
  },
} as PetPlugin;
