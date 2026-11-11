// Edges for IMG_9454 (entrance canopy), estimated by hand, in the 0-1000 grid the prompt asks for.
window.MOCK_ANSWER = {
  planes: [
    {
      name: 'Фасция козырька',
      edges: [
        { label: 'длина', note: 'верхнее ребро', x1: 120, y1: 71, x2: 796, y2: 211 },
        { label: 'высота', note: 'у правого края', x1: 796, y1: 211, x2: 797, y2: 248 },
      ],
    },
    {
      name: 'Торец козырька',
      edges: [{ label: 'высота', note: 'левый торец', x1: 119, y1: 70, x2: 125, y2: 122 }],
    },
    {
      name: 'Софит',
      edges: [{ label: 'глубина', note: 'вылет козырька', x1: 125, y1: 122, x2: 142, y2: 217 }],
    },
    {
      name: 'Колонна',
      edges: [
        { label: 'высота', note: 'по фанере', x1: 692, y1: 262, x2: 698, y2: 797 },
        { label: 'ширина', note: 'внизу', x1: 700, y1: 794, x2: 767, y2: 815 },
      ],
    },
  ],
};
