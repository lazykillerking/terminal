window.TERMINAL_FS_BUNDLE = {
  rootName: "terminal_fs",
  index: {
    type: "dir",
    children: {
      etc: {
        type: "dir",
        children: {
          "motd.txt": { type: "file" },
        },
      },
      notes: {
        type: "dir",
        children: {
          "ideas.txt": { type: "file" },
        },
      },
      projects: {
        type: "dir",
        children: {
          "lkk-site": {
            type: "dir",
            children: {
              "index.html": { type: "file" },
              "todo.md": { type: "file" },
            },
          },
        },
      },
      "readme.txt": { type: "file" },
    },
  },
  files: {
    "readme.txt": "Welcome to the real terminal filesystem.\nUse commands:\n- ls\n- cd\n- pwd\n- cat\n- tree\n",
    "etc/motd.txt": "Extreme terminal mode initialized.\n",
    "notes/ideas.txt": "Ideas:\n1) plugin architecture\n2) command pipelines\n3) vim mode\n",
    "projects/lkk-site/index.html":
      "<!doctype html>\n<html lang=\"en\">\n<head>\n  <meta charset=\"UTF-8\" />\n  <title>Virtual Mounted File</title>\n</head>\n<body>\n  <h1>Mounted File Preview</h1>\n</body>\n</html>\n",
    "projects/lkk-site/todo.md":
      "- refine terminal colors\n- add command aliases\n- add session persistence\n",
  },
};
