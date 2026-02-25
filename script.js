

const input = document.getElementById("commandInput");
const output = document.getElementById("output");

const commands = {
  help: () => `
Available commands:
help
whoami
clear
echo
about
`,

  whoami: () => "lkk",

  about: () => "LazyKillerKing Terminal v1.0",

  clear: () => {
    output.innerHTML = "";
    return "";
  },

  echo: (args) => args.join(" "),
};

input.addEventListener("keydown", function (e) {
  if (e.key === "Enter") {
    const value = input.value.trim();
    const [cmd, ...args] = value.split(" ");

    printLine(`lkk@terminal:~$ ${value}`);

    if (commands[cmd]) {
      const result = commands[cmd](args);
      if (result) printLine(result);
    } else if (value !== "") {
      printLine(`Command not found: ${cmd}`);
    }

    input.value = "";
    window.scrollTo(0, document.body.scrollHeight);
  }
});

function printLine(text) {
  const div = document.createElement("div");
  div.innerHTML = text;
  output.appendChild(div);
}