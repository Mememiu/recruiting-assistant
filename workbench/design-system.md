# 招聘看板系统 - 设计系统

## 1. 设计风格

**推荐风格：** Modern Professional + Subtle Glassmorphism

- 干净、专业的界面
- 微妙的玻璃质感效果
- 柔和的阴影和圆角
- 现代化的卡片设计

## 2. 配色方案

### 主色调（Primary）
- **主色：** `#6366f1` (Indigo-500) - 专业、信任感
- **深色：** `#4f46e5` (Indigo-600) - hover状态
- **浅色：** `#e0e7ff` (Indigo-100) - 背景高亮

### 辅助色（Secondary）
- **成功：** `#10b981` (Emerald-500) - 录用、通过
- **警告：** `#f59e0b` (Amber-500) - 待处理、空窗期
- **危险：** `#ef4444` (Red-500) - 淘汰、删除
- **信息：** `#3b82f6` (Blue-500) - 初试、进行中

### 中性色（Neutral）
- **背景：** `#f8fafc` (Slate-50)
- **卡片背景：** `#ffffff`
- **边框：** `#e2e8f0` (Slate-200)
- **文字主色：** `#0f172a` (Slate-900)
- **文字次要：** `#475569` (Slate-600)
- **文字占位符：** `#94a3b8` (Slate-400)

## 3. 字体配对

**推荐组合：** Inter + JetBrains Mono

```css
/* 主字体 - 用于正文 */
font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;

/* 等宽字体 - 用于数据展示 */
font-family: 'JetBrains Mono', 'Fira Code', monospace;
```

**Google Fonts 引用：**
```html
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
```

## 4. 圆角规范

- **小按钮/标签：** `border-radius: 6px`
- **输入框/按钮：** `border-radius: 8px`
- **卡片：** `border-radius: 12px`
- **模态框：** `border-radius: 16px`
- **头像：** `border-radius: 50%`

## 5. 阴影规范

```css
/* 轻微阴影 - 卡片默认 */
box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05), 0 1px 2px rgba(0, 0, 0, 0.03);

/* 中等阴影 - 卡片hover */
box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.08), 0 4px 6px -2px rgba(0, 0, 0, 0.04);

/* 强阴影 - 模态框 */
box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);
```

## 6. 间距规范

- **页面内边距：** `24px` (移动端 `16px`)
- **卡片内边距：** `24px`
- **元素间距：** `16px`
- **紧凑间距：** `8px`

## 7. 组件样式

### 按钮
```css
.btn-primary {
    background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
    border: none;
    border-radius: 8px;
    padding: 10px 20px;
    font-weight: 500;
    transition: all 200ms ease;
}

.btn-primary:hover {
    background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%);
    box-shadow: 0 4px 12px rgba(99, 102, 241, 0.4);
    transform: translateY(-1px);  /* 微妙上移 */
}
```

### 卡片
```css
.card {
    background: rgba(255, 255, 255, 0.8);
    backdrop-filter: blur(10px);
    border: 1px solid rgba(226, 232, 240, 0.8);
    border-radius: 12px;
    transition: all 200ms ease;
}

.card:hover {
    box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.08);
    border-color: rgba(99, 102, 241, 0.3);
    /* 注意：不要使用 transform: translateY 会导致布局偏移 */
}
```

### 输入框
```css
.form-control {
    border: 1.5px solid #e2e8f0;
    border-radius: 8px;
    padding: 10px 14px;
    transition: all 200ms ease;
}

.form-control:focus {
    border-color: #6366f1;
    box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.15);
}
```

### 标签/Badge
```css
.badge {
    padding: 4px 10px;
    border-radius: 6px;
    font-weight: 500;
    font-size: 0.75rem;
}

.badge-success { background: #d1fae5; color: #065f46; }
.badge-warning { background: #fef3c7; color: #92400e; }
.badge-danger { background: #fee2e2; color: #991b1b; }
.badge-info { background: #dbeafe; color: #1e40af; }
```

## 8. 图标规范

**推荐图标库：** Lucide Icons (更现代、一致)

```html
<script src="https://unpkg.com/lucide@latest"></script>
```

**图标尺寸：**
- 小图标：`16px`
- 默认图标：`20px`
- 大图标：`24px`
- 特大图标：`32px`

## 9. 动画规范

```css
/* 标准过渡 */
transition: all 200ms cubic-bezier(0.4, 0, 0.2, 1);

/* 入场动画 */
@keyframes fadeIn {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
}

/* 加载动画 */
@keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
}
```

## 10. 数据展示

### 数字/stat 卡片
```css
.stat-value {
    font-family: 'JetBrains Mono', monospace;
    font-size: 2rem;
    font-weight: 700;
    color: #0f172a;
    letter-spacing: -0.02em;
}

.stat-label {
    font-size: 0.875rem;
    color: #64748b;
    font-weight: 500;
}
```

## 11. 反对的设计（避免使用）

- ❌ 使用emoji作为图标
- ❌ 使用transform: translateY在hover（导致布局偏移）
- ❌ 使用低对比度文字（gray-400在白色背景上）
- ❌ 使用过多动画效果
- ❌ 使用渐变背景作为大面积背景色

## 12. 响应式断点

```css
/* 移动端 */
@media (max-width: 640px) { ... }

/* 平板 */
@media (min-width: 641px) and (max-width: 1024px) { ... }

/* 桌面 */
@media (min-width: 1025px) { ... }
```
