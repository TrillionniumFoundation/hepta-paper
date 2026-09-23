#include <cuda_runtime.h>

#include <cstdlib>
#include <fstream>
#include <string>

__global__ void square(const float* x, float* y, int n) {
  int i = blockIdx.x * blockDim.x + threadIdx.x;
  if (i < n) y[i] = x[i] * x[i];
}

int main() {
  const int n = 1024;
  float h[n];
  for (int i = 0; i < n; i++) h[i] = float(i);
  float *x, *y;
  cudaMalloc(&x, sizeof(h));
  cudaMalloc(&y, sizeof(h));
  cudaMemcpy(x, h, sizeof(h), cudaMemcpyHostToDevice);
  square<<<4, 256>>>(x, y, n);
  cudaDeviceSynchronize();
  cudaMemcpy(h, y, sizeof(h), cudaMemcpyDeviceToHost);
  cudaFree(x);
  cudaFree(y);
  if (h[17] != 289.0f) return 2;
  const char* output = std::getenv("HEPTA_OUTPUT_DIR");
  if (!output) return 3;
  std::ofstream out(std::string(output) + "/results.json");
  out << "{\"cuda_square_17\":" << h[17] << "}\n";
  return 0;
}
