export type IGesturePoint = { x: number, y: number }
export class Gesture {
    constructor() {

    }
    public ontouchstart({ touches }: TouchEvent) {
        return this.onstart([...touches].map(({ clientX, clientY }) => ({ x: clientX, y: clientY })))
    }
    private rad = 0;
    private distance = 0;
    public transformRes = {
        translateX: 0,
        transformY: 0,
        rotate: 0,
        scale: 1,
        transformText: ``
    }
    public transformOrigin = { x: 0, y: 0 }
    public onstart(pointStartPositions: IGesturePoint[]) {
        if (!pointStartPositions[1]) return
        this.rad = Gesture.getRad(pointStartPositions[0], pointStartPositions[1]);
        this.distance = Gesture.getDistance(pointStartPositions[0], pointStartPositions[1]);
        document.body.ontouchmove = ({ touches }) => {
            if (!touches[1]) return
            const pointEndPositions = [...touches].map(({ clientX, clientY }) => ({ x: clientX, y: clientY }))
            const newRad = Gesture.getRad(pointEndPositions[0], pointEndPositions[1])
            const rotate = newRad - this.rad;
            const scale = Gesture.getDistance(pointEndPositions[0], pointEndPositions[1]) / this.distance
            const afterRotatePoint = Gesture.afterRotate(pointStartPositions[0], this.transformOrigin, rotate, scale)
            const translateX = pointEndPositions[0].x - afterRotatePoint.x
            const transformY = pointEndPositions[0].y - afterRotatePoint.y
            this.transformRes.translateX = translateX;
            this.transformRes.transformY = transformY;
            this.transformRes.rotate = rotate;
            this.transformRes.scale = scale;
            this.transformRes.transformText = `translate3d(${translateX}px, ${transformY}px,0) rotate3d(0, 0, 1,${rotate}rad) scale3d(${scale},${scale},${scale})`
            this.onTransform()
        }
    }
    public onTransform = () => { }

    /** 获取两点组成的线段的弧度 */
    public static getRad = (p1: IGesturePoint, p2: IGesturePoint) => Math.atan2((p2.y - p1.y), (p2.x - p1.x))
    /** 两点间距离 */
    public static getDistance = (p1: IGesturePoint, p2: IGesturePoint) => Math.sqrt(Math.pow(p1.x - p2.x, 2) + Math.pow(p1.y - p2.y, 2));
    /** 旋转后的新坐标 */
    public static afterRotate = (p: IGesturePoint, origin: IGesturePoint, rad: number, scale: number): IGesturePoint => {
        const x = p.x - origin.x;
        const y = p.y - origin.y;
        /** 参考：https://blog.csdn.net/weixin_34910922/article/details/121569340 */
        return {
            x: (Math.cos(rad) * x - Math.sin(rad) * y) * scale + origin.x,
            y: (Math.sin(rad) * x + Math.cos(rad) * y) * scale + origin.y,
        }
    }
}

const gesture = new Gesture();
const img = new Image();
img.src = "https://t7.baidu.com/it/u=2621658848,3952322712&fm=193";

img.onload = () => {
    img.style.transformOrigin = `0px 0px`;
    img.style.position = "fixed";
    img.style.left = "0";
    img.style.top = "0"
    document.body.appendChild(img);
    document.body.ontouchstart = gesture.ontouchstart.bind(gesture)
    gesture.onTransform = () => {
        img.style.transform = gesture.transformRes.transformText
    }
}