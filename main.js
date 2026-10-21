const action = document.querySelector("#demo-action");
const status = document.querySelector("#demo-status");
let count = 0;

action?.addEventListener("click", () => {
  count += 1;
  if (status) status.textContent = count === 1 ? "It works — now make it yours." : "Interaction count: " + count;
});
