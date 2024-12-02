#include <stdlib.h>

int foo(void) {
  int *p = malloc(sizeof(int));
  *p = 42;
  return 0;
}

int bar(void) {
  int *p = malloc(sizeof(int));
  *p = 42;
  foo();
  return 0;
}

int main() {
  int *p = malloc(sizeof(int));
  *p = 42;
  foo();
  bar();
  free(p);
  return 0;
}
