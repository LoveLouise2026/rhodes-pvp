v88 卡牌图片使用说明

1. 图片放入 public/images/cards/
2. 推荐文件名直接用唯一ID，例如 SD03-0001.webp
3. 在 data/cards.json 或 data/base-cards.json 写：
   "image": "/images/cards/SD03-0001.webp"
4. 没有图片时写：
   "image": ""
5. 推荐 webp，也支持 png / jpg / jpeg。

v88 会在以下公开区域统一显示卡图：
- 我方手牌
- 战场公开卡牌
- 弃牌区顶部
- 左侧详情
- 卡组编辑器
- 效果/处理顺序选择卡面

不会泄露：
- 对方手牌
- 基地生命卡背
- 盖放状态卡牌
