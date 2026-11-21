# 课堂 Composer 默认执行配置

## 背景

课堂学生新建任务时，Composer 会继承最近一次草稿的模式和模型档位。学生会看到“完全访问”与
“最高”思考强度同时出现，导致课堂模型消耗高、响应慢。课堂需要稳定的低成本默认值。

## 产品规则

1. 仅在课堂模式、仅对新任务草稿生效：
   - 权限/执行模式默认 `yolo`（界面：完全访问）；
   - 模型思考强度默认 `low`（界面：低）。
2. 每次新建任务由 `draftFocusVersion` 触发一次课堂默认值应用。
3. 同一条新任务草稿内，学生手动修改模式或思考强度后，不得被后续 render 覆盖。
4. 打开已有任务时不得改写该任务保存的模型、模式或思考强度。
5. 模型不支持 `low` 时保留模型的有效默认档位，不能提交非法档位。
6. 普通 ZCode 课堂外模式不改变现有初始化、Recent 或显式选择规则。

## 所有权与事件顺序

```text
课堂 startDraft()
  -> draftFocusVersion + 1
  -> useDraftConfigControl 读取当前 ModelSelectionView
  -> 新任务草稿首次应用 yolo + low
  -> 写入当前 Composer Draft
  -> 用户修改后保存用户显式选择
  -> Submission 使用最新 Draft 配置
```

- `V4ComposerDraft` 是当前草稿选择事实源。
- `useDraftConfigControl` 是课堂新任务默认值唯一写入点。
- 模型能力以 `ModelSelectionView` 为唯一依据；UI 不伪造不支持的档位。

## 验收

1. 课堂新任务默认模式为 `yolo`。
2. 支持 `low` 的课堂模型默认思考强度为 `low`。
3. 学生手动切到其他档位后，同一条草稿保持该选择。
4. 再次点击新建任务时重新应用课堂默认值。
5. 打开已有任务不触发默认值重置。
6. 普通 ZCode 模式行为不变。
