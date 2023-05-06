"use strict";
const initTreeNode = {
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
const pre_order_traversal = (treeNode) => {
    if (!treeNode)
        return;
    console.log(treeNode.val);
    pre_order_traversal(treeNode.left);
    pre_order_traversal(treeNode.right);
};
const in_order_traversal = (treeNode) => {
    if (!treeNode)
        return;
    in_order_traversal(treeNode.left);
    console.log(treeNode.val);
    in_order_traversal(treeNode.right);
};
const post_order_traversal = (treeNode) => {
    if (!treeNode)
        return;
    post_order_traversal(treeNode.left);
    post_order_traversal(treeNode.right);
    console.log(treeNode.val);
};
const level = (treeNode) => {
    if (!treeNode)
        return;
    const queue = [treeNode];
    let node;
    while ((node = queue.shift())) {
        console.log(node.val);
        if (node.left)
            queue.push(node.left);
        if (node.right)
            queue.push(node.right);
    }
};
const pre_order_traversal2p = (treeNode) => {
    if (!treeNode)
        return;
    const stack = [treeNode];
    let node;
    while ((node = stack.pop())) {
        while (node) {
            console.log(node.val);
            if (node.right)
                stack.push(node.right);
            node = node.left;
        }
    }
};
const pre_order_traversal2 = (treeNode) => {
    const stack = [];
    let node = treeNode;
    while (node || stack.length) {
        while (node) {
            console.log(node.val);
            stack.push(node);
            node = node.left;
        }
        if ((node = stack.pop())) {
            node = node.right;
        }
    }
};
const in_order_traversal2 = (treeNode) => {
    const stack = [];
    let node = treeNode;
    while (node || stack.length) {
        while (node) {
            stack.push(node);
            node = node.left;
        }
        if ((node = stack.pop())) {
            console.log(node.val);
            node = node.right;
        }
    }
};
const post_order_traversal2 = (treeNode) => {
    if (!treeNode)
        return;
    const stack = [treeNode];
    let node;
    let preNode = null;
    while ((node = stack.pop())) {
        if ((node.left === null && node.right === null) || (preNode && (preNode === node.left || preNode == node.right))) {
            console.log(node.val);
            preNode = node;
        }
        else {
            stack.push(node);
            if (node.right)
                stack.push(node.right);
            if (node.left)
                stack.push(node.left);
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
//# sourceMappingURL=%E4%BA%8C%E5%8F%89%E6%A0%91%E9%81%8D%E5%8E%86.js.map