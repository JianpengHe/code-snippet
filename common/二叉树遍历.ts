interface TreeNode {
  val: number;
  left: TreeNode | null;
  right: TreeNode | null;
}

/**
 * 用例
 *         1
 *       /   \
 *      2     3
 *     / \     \
 *    4   5     6
 *       /
 *      7
 */
const initTreeNode: TreeNode = {
  val: 1,
  left: {
    val: 2,
    left: {
      val: 4,
      left: null,
      right: null,
    },
    right: {
      val: 5,
      left: {
        val: 7,
        left: null,
        right: null,
      },
      right: null,
    },
  },
  right: {
    val: 3,
    left: null,
    right: {
      val: 6,
      left: null,
      right: null,
    },
  },
};

/** 前序遍历 (1,2,4,5,7,3,6)
 * 根结点 -> 左子树 -> 右子树
 * 一步一步往左边走，没路了就往回走一步，再看右边
 *  */
const pre_order_traversal = (treeNode: TreeNode | null) => {
  if (!treeNode) return;

  console.log(treeNode.val); // 输出在最前面
  pre_order_traversal(treeNode.left);
  pre_order_traversal(treeNode.right);
};

/** 中序遍历 (4,2,7,5,1,3,6)
 * 左子树 -> 根结点 -> 右子树
 * 只要左边有路就直接跳，直到没路就往回走一步，再看右边
 *  */
const in_order_traversal = (treeNode: TreeNode | null) => {
  if (!treeNode) return;

  in_order_traversal(treeNode.left);
  console.log(treeNode.val); // 输出在中间
  in_order_traversal(treeNode.right);
};

/** 后序遍历 (4,7,5,2,6,3,1)
 * 左子树 -> 右子树 -> 根结点
 * 靠左跳到最下边，
 *  */
const post_order_traversal = (treeNode: TreeNode | null) => {
  if (!treeNode) return;

  post_order_traversal(treeNode.left);
  post_order_traversal(treeNode.right);
  console.log(treeNode.val); // 输出在最后面
};

/** 广度优先遍历 (1,2,3,4,5,6,7) */
const level = (treeNode: TreeNode | null) => {
  if (!treeNode) return;

  const queue: TreeNode[] = [treeNode];
  let node: TreeNode | undefined;

  while ((node = queue.shift())) {
    /** 从队头取出一个元素 */
    console.log(node.val);
    if (node.left) queue.push(node.left);
    if (node.right) queue.push(node.right);
  }
};

/** 前序遍历（不使用递归），主要思路：右孩子入栈左孩子耗光， 没左孩子了就取一个右孩子，继续耗光左孩子，以此类推 */
const pre_order_traversal2p = (treeNode: TreeNode | null) => {
  if (!treeNode) return;

  const stack: TreeNode[] = [treeNode];
  let node: TreeNode | undefined | null;

  while ((node = stack.pop())) {
    /** 只取一个右孩子 */
    while (node) {
      console.log(node.val);
      /** 把右孩子先放在栈中，优先耗光左孩子 */
      if (node.right) stack.push(node.right);
      node = node.left;
    }
  }
};

/** 前序遍历（不使用递归），常规思路 **/
const pre_order_traversal2 = (treeNode: TreeNode | null) => {
  const stack: TreeNode[] = [];
  let node: TreeNode | undefined | null = treeNode;

  while (node || stack.length) {
    while (node) {
      console.log(node.val);
      /** 把所有孩子先放在栈中，指针指向左孩子 */
      stack.push(node);
      node = node.left;
    }
    /** 从栈中只取一个孩子 */
    if ((node = stack.pop())) {
      /** 指针指向右孩子 */
      node = node.right;
    }
  }
};

/** 中序遍历（不使用递归） */
const in_order_traversal2 = (treeNode: TreeNode | null) => {
  const stack: TreeNode[] = [];
  let node: TreeNode | undefined | null = treeNode;

  while (node || stack.length) {
    while (node) {
      /** 把所有孩子先放在栈中，指针指向左孩子 */
      stack.push(node);
      node = node.left;
    }
    /** 从栈中只取一个孩子 */
    if ((node = stack.pop())) {
      console.log(node.val);
      /** 指针指向右孩子 */
      node = node.right;
    }
  }
};

/** 后序遍历（不使用递归） */
const post_order_traversal2 = (treeNode: TreeNode | null) => {
  if (!treeNode) return;

  const stack: TreeNode[] = [treeNode];
  /** 当前结点 */
  let node: TreeNode | undefined | null;
  /** 前一次访问的结点 */
  let preNode: TreeNode | undefined | null = null;

  while ((node = stack.pop())) {
    /** 如果当前结点没有孩子结点或者孩子节点都已被访问过 */
    if ((node.left === null && node.right === null) || (preNode && (preNode === node.left || preNode == node.right))) {
      console.log(node.val);
      preNode = node;
    } else {
      /** 没有访问，所以返回栈中 */
      stack.push(node);
      if (node.right) stack.push(node.right);
      if (node.left) stack.push(node.left);
    }
  }
};

console.log("前序遍历");
pre_order_traversal(initTreeNode);
pre_order_traversal2p(initTreeNode);
pre_order_traversal2(initTreeNode);

console.log("中序遍历");
in_order_traversal(initTreeNode);
in_order_traversal2(initTreeNode);

console.log("后序遍历");
post_order_traversal(initTreeNode);
post_order_traversal2(initTreeNode);

console.log("广度优先遍历");
level(initTreeNode);
