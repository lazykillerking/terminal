window.TERMINAL_FS_BUNDLE = {
  rootName: "terminal_fs",
  index: {
  "type": "dir",
  "children": {
    "etc": {
      "type": "dir",
      "children": {
        "motd.txt": {
          "type": "file"
        }
      }
    },
    "notes": {
      "type": "dir",
      "children": {
        "ideas.txt": {
          "type": "file"
        }
      }
    },
    "projects": {
      "type": "dir",
      "children": {
        "lkk-site": {
          "type": "dir",
          "children": {
            "index.html": {
              "type": "file"
            },
            "todo.md": {
              "type": "file"
            }
          }
        }
      }
    },
    "readme.txt": {
      "type": "file"
    }
  }
},
  files: {
  "etc/motd.txt": "Extreme terminal mode initialized.\r\n",
  "notes/ideas.txt": "Ideas:\r\n1) plugin architecture\r\n2) command pipelines\r\n3) vim mode\r\n",
  "projects/lkk-site/index.html": "<!doctype html>\r\n<html lang=\"en\">\r\n<head>\r\n  <meta charset=\"UTF-8\" />\r\n  <title>Virtual Mounted File</title>\r\n</head>\r\n<body>\r\n  <h1>Mounted File Preview</h1>\r\n</body>\r\n</html>\r\n",
  "projects/lkk-site/todo.md": "- refine terminal colors\r\n- add command aliases\r\n- add session persistence\r\n",
  "readme.txt": "Welcome to the real terminal filesystem.\r\nUse commands:\r\n- ls\r\n- cd\r\n- pwd\r\n- cat\r\n- tree\r\n"
}
};
