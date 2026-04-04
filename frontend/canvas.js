const canvas = document.getElementById("board");
const ctx = canvas.getContext("2d");

let drawing = false;

canvas.addEventListener("mousedown", () => drawing = true);

canvas.addEventListener("mouseup", () => {
	drawing = false;
	ctx.beginPath();
});

canvas.addEventListener("mouseleave", () => {
	drawing = false;
	ctx.beginPath();
});

canvas.addEventListener("mousemove", draw);

function draw(e) {
	if (!drawing) return;

	ctx.lineWidth = 2;
	ctx.lineCap = "round";

	ctx.lineTo(e.offsetX, e.offsetY);
	ctx.stroke();

	ctx.beginPath();
	ctx.moveTo(e.offsetX, e.offsetY);
}
