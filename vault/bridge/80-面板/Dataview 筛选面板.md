# Dataview 筛选面板

使用前提：已安装并启用 Obsidian 的 Dataview 插件。

这页的目标不是展示所有信息，而是让你按 `人 / 产品 / 场景 / 可销售性` 快速扫描。

## 人物

```dataview
TABLE name AS "人物", role AS "角色", organization AS "组织", sellability AS "销售判断", status AS "状态"
FROM ""
WHERE note_type = "person" AND contains(file.folder, "知识库/人物")
SORT file.name ASC
```

## 产品

```dataview
TABLE name AS "产品", category AS "类别", core_promise AS "核心卖点", pricing AS "价格", sellability_score AS "分数", sales_stage AS "阶段"
FROM ""
WHERE note_type = "product" AND contains(file.folder, "知识库/产品")
SORT sellability_score DESC, file.name ASC
```

## 场景

```dataview
TABLE name AS "场景", trigger AS "触发条件", pain_level AS "痛感", urgency AS "紧急度", budget_signal AS "预算信号", status AS "状态"
FROM ""
WHERE note_type = "scenario" AND contains(file.folder, "知识库/场景")
SORT urgency DESC, pain_level DESC
```

## 可销售性

```dataview
TABLE name AS "评估", person AS "人物", product AS "产品", scenario AS "场景", overall_score AS "总分", recommended_action AS "建议动作", status AS "状态"
FROM ""
WHERE note_type = "sellability" AND contains(file.folder, "知识库/可销售性")
SORT overall_score DESC, file.name ASC
```

## 优先跟进池

```dataview
TABLE person AS "人物", product AS "产品", scenario AS "场景", overall_score AS "总分", recommended_action AS "建议动作"
FROM ""
WHERE note_type = "sellability" AND contains(file.folder, "知识库/可销售性") AND overall_score >= 7 AND status != "archived"
SORT overall_score DESC
```

## 使用建议

- 人物卡里尽量链接产品和场景
- 产品卡里尽量写清楚价格、承诺和对象
- 场景卡要写触发条件和预算信号
- 可销售性卡只处理“谁买什么、为什么现在会买”已经有答案的组合
